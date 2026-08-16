/**
 * Tesla Dashcam Stamp - Main Application Controller
 * Handles WebGL rendering pipeline, WebCodecs video recording,
 * timeline interaction, video playback, and UI event bindings.
 */

(function () {
    // Device detection helpers
    const isIOSDevice = () => {
        if (typeof navigator === 'undefined') return false;
        return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
            (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    };

    let fps = 36;
    let targetBitrate = isIOSDevice() ? Math.round(6000000 * 2.0) : 6000000;
    const MP4_EPOCH_OFFSET = 2082844800;
    let originalMediaDate = null;
    let originalFileLastModified = null;
    let firstPlayLock = false;
    let firstKeyFrameTime = 0;
    let firstPlayTargetTime = 0;
    let scrubThrottleMs = 16;

    // DOM References
    const fileInput = document.querySelector("#fileInput");
    const dropZone = document.querySelector("#dropZone");
    const startRecBtn = document.querySelector("#startRecBtn");
    const stopRecBtn = document.querySelector("#stopRecBtn");
    const reselectBtn = document.querySelector("#reselectBtn");
    const playPauseBtn = document.querySelector("#playPauseBtn");
    const statusText = document.querySelector("#statusText");
    const timeDisplay = document.querySelector("#timeDisplay");
    const videoViewer = document.querySelector("#videoViewer");
    const timeSlider = document.querySelector("#timeSlider");
    const guideHeader = document.querySelector("#guideHeader");
    const guideSteps = document.querySelector("#guideSteps");
    const toggleIcon = document.querySelector("#toggleIcon");
    const langOptZh = document.querySelector("#langOptZh");
    const langOptEn = document.querySelector("#langOptEn");

    // Slider time mapping helpers
    const sliderToTime = (sliderVal, duration, fkft) => {
        const d = duration, f = fkft || 0;
        return f + (sliderVal / 1000) * (d - f);
    };
    const timeToSlider = (time, duration, fkft) => {
        const d = duration, f = fkft || 0;
        const eff = d - f;
        if (eff <= 0) return (time / d) * 1000;
        return Math.max(0, (time - f) / eff) * 1000;
    };

    if (langOptZh) langOptZh.onclick = () => setLang('zh');
    if (langOptEn) langOptEn.onclick = () => setLang('en');

    if (guideHeader) {
        guideHeader.onclick = () => {
            guideSteps.classList.toggle("collapsed");
            toggleIcon.classList.toggle("collapsed");
        };
    }

    // --- Rendering Initialization ---
    const cvs = document.querySelector("#videoCanvas");
    const gl = cvs.getContext('webgl2', { alpha: false, antialias: false, depth: false });

    // Feature detection
    const supportsWebCodecs = ("VideoEncoder" in window) && ("VideoDecoder" in window);
    const hasWebGL = !!(gl);

    if (!hasWebGL) {
        alert(t('webglAlert'));
    }

    // WebGL resources
    let vsSource, fsSource, compileShader;
    let vertexShader, fragmentShader, program;
    let positionLoc, texCoordLoc, videoTexLoc, textTexLoc, barRatioLoc;
    let positionBuffer, texCoordBuffer, vao;
    let videoTexture, textTexture;

    if (hasWebGL) {
        vsSource = `#version 300 es
        in vec4 a_position;
        in vec2 a_texCoord;
        out vec2 v_texCoord;
        void main() {
            gl_Position = a_position;
            v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
        }`;

        fsSource = `#version 300 es
        precision highp float;
        in vec2 v_texCoord;
        uniform sampler2D u_videoTex;
        uniform sampler2D u_textTex;
        uniform float u_barRatio;
        out vec4 outColor;
        
        void main() {
            vec4 vidColor = texture(u_videoTex, v_texCoord);
            vec4 textColor = vec4(0.0);
            
            float barStart = 1.0 - u_barRatio;
            if (v_texCoord.y >= barStart && u_barRatio > 0.0) {
                vec2 textUV = vec2(v_texCoord.x, (v_texCoord.y - barStart) / u_barRatio);
                textColor = texture(u_textTex, textUV);
            }
            
            outColor = mix(vidColor, textColor, textColor.a);
        }`;

        compileShader = (gl, type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error("Shader compile error:", gl.getShaderInfoLog(shader));
                gl.deleteShader(shader);
                return null;
            }
            return shader;
        };

        vertexShader = compileShader(gl, gl.VERTEX_SHADER, vsSource);
        fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
        program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(program);
            console.error("WebGL program link error:", info);
            alert(t('shaderAlert') + info);
            throw new Error("WebGL program link failed: " + info);
        }

        positionLoc = gl.getAttribLocation(program, "a_position");
        texCoordLoc = gl.getAttribLocation(program, "a_texCoord");
        videoTexLoc = gl.getUniformLocation(program, "u_videoTex");
        textTexLoc = gl.getUniformLocation(program, "u_textTex");
        barRatioLoc = gl.getUniformLocation(program, "u_barRatio");

        positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0
        ]), gl.STATIC_DRAW);

        texCoordBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0
        ]), gl.STATIC_DRAW);

        // VAO (Vertex Array Object) recording
        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.enableVertexAttribArray(positionLoc);
        gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
        gl.enableVertexAttribArray(texCoordLoc);
        gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);

        videoTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, videoTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

        textTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, textTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }

    // Offscreen Canvas for Text Rendering
    const textCanvas = document.createElement('canvas');
    const textCtx = textCanvas.getContext('2d');
    let lastRenderedTimeStr = "";
    let lastRenderedSeiStr = "";

    let cachedCanvasWidth = -1;
    let cachedCanvasHeight = -1;
    let cachedFontSize = 0;
    let cachedTextWidth = 0;
    let cachedLayout = null;
    let cachedSingleDigitWidth = 0;
    let textTextureInitialized = false;

    let vid = null;
    let dragging = false;
    let vidName = "tesla_dashcam";
    let videoStartTime = 0;
    let isRecording = false;
    let animationId = null;
    let playPending = false;
    let currentVideoUrl = null;
    let compositeBarHeight = 0;
    let compositeSplitBelow = false;

    let parsedFrames = [];
    let enumFields = null;
    let currentParser = null;
    let eventLocation = null;
    const reusableDate = new Date();

    const createFreshVideo = () => {
        const old = document.getElementById("hiddenVideo");
        if (old) {
            old.pause();
            if (currentVideoUrl) { URL.revokeObjectURL(currentVideoUrl); currentVideoUrl = null; }
            old.removeAttribute('src'); old.load();
            if (old._readyPollTimer) { clearInterval(old._readyPollTimer); old._readyPollTimer = null; }
            old.remove();
        }
        const v = document.createElement("video");
        v.id = "hiddenVideo"; v.muted = true;
        v.setAttribute("playsinline", "true");
        v.setAttribute("webkit-playsinline", "true");
        v.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;";
        document.body.appendChild(v);
        return v;
    };

    const formatTime = (seconds) => {
        const m = Math.floor(seconds / 60); const s = Math.floor(seconds % 60);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    const formatDate = (date) => {
        const pad = (n) => n.toString().padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };

    const makeEvenDimension = (value) => {
        const rounded = Math.max(2, Math.round(value));
        return rounded % 2 === 0 ? rounded : rounded + 1;
    };

    const getInfoBarHeight = (width) => makeEvenDimension(Math.max(36, Math.ceil(width / 40 * 2)));
    const getCompositeLayout = (videoWidth, videoHeight) => {
        const splitBelow = (videoWidth / videoHeight) > 1.5;
        const barHeight = getInfoBarHeight(videoWidth);
        const compositeHeight = splitBelow ? videoHeight + barHeight : videoHeight;
        return {
            width: makeEvenDimension(videoWidth),
            height: makeEvenDimension(compositeHeight),
            splitBelow,
            barHeight
        };
    };

    const EXPORT_MAX_WIDTH = 1920;
    const getScaledCompositeLayout = (videoWidth, videoHeight, maxWidth) => {
        const base = getCompositeLayout(videoWidth, videoHeight);
        const scale = maxWidth > 0 && base.width > maxWidth ? maxWidth / base.width : 1;
        return {
            width: makeEvenDimension(base.width * scale),
            height: makeEvenDimension(base.height * scale),
            splitBelow: base.splitBelow,
            barHeight: makeEvenDimension(base.barHeight * scale)
        };
    };

    const syncPlayButton = (isPaused) => {
        playPauseBtn.innerHTML = isPaused
            ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
            : '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
    };

    const transformLat = (x, y) => {
        let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
        ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
        return ret;
    };

    const transformLon = (x, y) => {
        let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
        ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
        return ret;
    };

    const gcj02ToWgs84 = (gcjLat, gcjLon) => {
        if (gcjLon < 72.004 || gcjLon > 137.8347 || gcjLat < 0.8293 || gcjLat > 55.8271) {
            return [gcjLat, gcjLon];
        }
        const a = 6378245.0;
        const ee = 0.00669342162296594323;
        let dLat = transformLat(gcjLon - 105.0, gcjLat - 35.0);
        let dLon = transformLon(gcjLon - 105.0, gcjLat - 35.0);
        const radLat = gcjLat / 180.0 * Math.PI;
        let magic = Math.sin(radLat);
        magic = 1 - ee * magic * magic;
        const sqrtMagic = Math.sqrt(magic);
        dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
        dLon = (dLon * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
        return [gcjLat - dLat, gcjLon - dLon];
    };

    const formatISO6709 = (lat, lon) => {
        let latNum = typeof lat === 'number' ? lat : parseFloat(lat);
        let lonNum = typeof lon === 'number' ? lon : parseFloat(lon);
        if (isNaN(latNum) || isNaN(lonNum)) return null;

        // Tesla 国内车机 event.json 记录的是国测局 GCJ-02 火星坐标。
        // iOS 相册读取元数据时默认将其视作 WGS-84 并自动叠加国内高德地图的火星偏转（WGS84 -> GCJ02）。
        // 因此在此逆向转换为 WGS-84，使 iOS 地图还原时精准落到真实位置，避免 100~200 米的二次加偏。
        const [wgsLat, wgsLon] = gcj02ToWgs84(latNum, lonNum);

        const latSign = wgsLat >= 0 ? '+' : '-';
        const lonSign = wgsLon >= 0 ? '+' : '-';
        const latStr = `${latSign}${Math.abs(wgsLat).toFixed(6)}`;
        const lonStr = `${lonSign}${Math.abs(wgsLon).toFixed(6)}`;
        return `${latStr}${lonStr}/`;
    };

    const buildLocationMetaBox = (isoStr) => {
        const enc = new TextEncoder();
        const keyNameBytes = enc.encode('com.apple.quicktime.location.ISO6709');
        const valBytes = enc.encode(isoStr);

        const dataBoxSize = 16 + valBytes.length;
        const itemBoxSize = 8 + dataBoxSize;
        const ilstBoxSize = 8 + itemBoxSize;
        const keyEntrySize = 8 + keyNameBytes.length;
        const keysBoxSize = 16 + keyEntrySize;
        const hdlrBoxSize = 33;
        // In QuickTime, `meta` is a simple Box with 8-byte header (not a FullBox)
        const metaBoxSize = 8 + hdlrBoxSize + keysBoxSize + ilstBoxSize;

        const buf = new Uint8Array(metaBoxSize);
        const view = new DataView(buf.buffer);
        let o = 0;

        view.setUint32(o, metaBoxSize); o += 4;
        buf.set(enc.encode('meta'), o); o += 4;

        // hdlr box
        view.setUint32(o, hdlrBoxSize); o += 4;
        buf.set(enc.encode('hdlr'), o); o += 4;
        view.setUint32(o, 0); o += 4; // version 0, flags 0
        view.setUint32(o, 0); o += 4; // component type / predefined 0
        buf.set(enc.encode('mdta'), o); o += 4; // component subtype 'mdta'
        buf.set(enc.encode('appl'), o); o += 4; // component manufacturer 'appl'
        view.setUint32(o, 0); o += 4; // component flags 0
        view.setUint32(o, 0); o += 4; // component flags mask 0
        buf[o] = 0; o += 1; // component name (Pascal string with length 0)

        // keys box (FullBox)
        view.setUint32(o, keysBoxSize); o += 4;
        buf.set(enc.encode('keys'), o); o += 4;
        view.setUint32(o, 0); o += 4; // version 0, flags 0
        view.setUint32(o, 1); o += 4; // entry count 1

        // key entry 1
        view.setUint32(o, keyEntrySize); o += 4;
        buf.set(enc.encode('mdta'), o); o += 4;
        buf.set(keyNameBytes, o); o += keyNameBytes.length;

        // ilst box
        view.setUint32(o, ilstBoxSize); o += 4;
        buf.set(enc.encode('ilst'), o); o += 4;

        // item 1 (index 1)
        view.setUint32(o, itemBoxSize); o += 4;
        view.setUint32(o, 1); o += 4; // 1-based index

        // data box
        view.setUint32(o, dataBoxSize); o += 4;
        buf.set(enc.encode('data'), o); o += 4;
        view.setUint32(o, 1); o += 4; // type indicator 1 = UTF-8 text
        view.setUint32(o, 0); o += 4; // locale 0
        buf.set(valBytes, o); o += valBytes.length;

        return buf;
    };

    const buildLocationUdtaBox = (isoStr) => {
        const enc = new TextEncoder();
        const valBytes = enc.encode(isoStr);

        const xyzBoxSize = 12 + valBytes.length;
        const udtaBoxSize = 8 + xyzBoxSize;

        const buf = new Uint8Array(udtaBoxSize);
        const view = new DataView(buf.buffer);
        let o = 0;

        view.setUint32(o, udtaBoxSize); o += 4;
        buf.set(enc.encode('udta'), o); o += 4;

        view.setUint32(o, xyzBoxSize); o += 4;
        buf[o] = 0xA9; buf[o + 1] = 0x78; buf[o + 2] = 0x79; buf[o + 3] = 0x7A; o += 4;
        view.setUint16(o, valBytes.length); o += 2;
        view.setUint16(o, 0x15C7); o += 2;
        buf.set(valBytes, o); o += valBytes.length;

        return buf;
    };

    const patchMp4Metadata = (buffer, creationTime, location = null) => {
        let workBuffer = buffer;

        if (location && location.lat !== undefined && location.lon !== undefined) {
            const isoStr = formatISO6709(location.lat, location.lon);
            if (isoStr) {
                const metaBox = buildLocationMetaBox(isoStr);
                const udtaBox = buildLocationUdtaBox(isoStr);
                const extraLength = metaBox.length + udtaBox.length;
                const extraBytes = new Uint8Array(extraLength);
                extraBytes.set(metaBox, 0);
                extraBytes.set(udtaBox, metaBox.length);

                let view = new DataView(workBuffer);
                let moovInfo = null;
                let mdatInfo = null;

                let pos = 0;
                while (pos + 8 <= workBuffer.byteLength) {
                    let boxSize = view.getUint32(pos);
                    const boxType = view.getUint32(pos + 4);
                    let headerSize = 8;
                    if (boxSize === 1 && pos + 16 <= workBuffer.byteLength) {
                        const high = view.getUint32(pos + 8);
                        const low = view.getUint32(pos + 12);
                        boxSize = Number((BigInt(high) << 32n) | BigInt(low));
                        headerSize = 16;
                    } else if (boxSize === 0) {
                        boxSize = workBuffer.byteLength - pos;
                    }
                    if (boxSize < 8 || pos + boxSize > workBuffer.byteLength) break;

                    if (boxType === 0x6D6F6F76) {
                        moovInfo = { start: pos, end: pos + boxSize, size: boxSize, headerSize };
                    } else if (boxType === 0x6D646174) {
                        mdatInfo = { start: pos, size: boxSize };
                    }
                    pos += boxSize;
                }

                if (moovInfo) {
                    const deltaSize = extraLength;
                    const isMdatAfterMoov = mdatInfo && mdatInfo.start > moovInfo.start;

                    if (isMdatAfterMoov) {
                        const adjustChunkOffsets = (start, end) => {
                            let offset = start;
                            while (offset + 8 <= end) {
                                const boxSize = view.getUint32(offset);
                                const boxType = view.getUint32(offset + 4);
                                if (boxSize < 8 || offset + boxSize > end) break;

                                if (boxType === 0x7374636F) {
                                    const entryCount = view.getUint32(offset + 12);
                                    for (let i = 0; i < entryCount; i++) {
                                        const entryOffset = offset + 16 + i * 4;
                                        if (entryOffset + 4 <= end) {
                                            const oldVal = view.getUint32(entryOffset);
                                            view.setUint32(entryOffset, oldVal + deltaSize);
                                        }
                                    }
                                } else if (boxType === 0x636F3634) {
                                    const entryCount = view.getUint32(offset + 12);
                                    for (let i = 0; i < entryCount; i++) {
                                        const entryOffset = offset + 16 + i * 8;
                                        if (entryOffset + 8 <= end) {
                                            const oldVal = view.getBigUint64(entryOffset);
                                            view.setBigUint64(entryOffset, oldVal + BigInt(deltaSize));
                                        }
                                    }
                                } else if (
                                    boxType === 0x6D6F6F76 ||
                                    boxType === 0x7472616B ||
                                    boxType === 0x6D646961 ||
                                    boxType === 0x6D696E66 ||
                                    boxType === 0x7374626C
                                ) {
                                    adjustChunkOffsets(offset + 8, offset + boxSize);
                                }
                                offset += boxSize;
                            }
                        };
                        adjustChunkOffsets(moovInfo.start + moovInfo.headerSize, moovInfo.end);
                    }

                    view.setUint32(moovInfo.start, moovInfo.size + deltaSize);

                    const newBuffer = new Uint8Array(workBuffer.byteLength + deltaSize);
                    newBuffer.set(new Uint8Array(workBuffer, 0, moovInfo.end), 0);
                    newBuffer.set(extraBytes, moovInfo.end);
                    newBuffer.set(new Uint8Array(workBuffer, moovInfo.end), moovInfo.end + deltaSize);

                    workBuffer = newBuffer.buffer;
                }
            }
        }

        if (creationTime) {
            const view = new DataView(workBuffer);
            const bigCreationTime = BigInt(creationTime);
            const targets = new Set([0x6D766864, 0x746B6864, 0x6D646864]);
            const containers = new Set([
                0x6D6F6F76,
                0x7472616B,
                0x6D646961,
                0x6D696E66,
                0x75647461,
                0x6D657461
            ]);

            const patchBoxes = (start, end) => {
                let offset = start;
                while (offset + 8 <= end) {
                    const boxSize = view.getUint32(offset);
                    const boxType = view.getUint32(offset + 4);
                    if (boxSize < 8 || offset + boxSize > end) break;
                    if (targets.has(boxType)) {
                        const version = view.getUint8(offset + 8);
                        const dataOffset = offset + 12;
                        if (version === 0 && dataOffset + 8 <= end) {
                            if (bigCreationTime <= 0xFFFFFFFFn) {
                                view.setUint32(dataOffset, Number(bigCreationTime));
                                view.setUint32(dataOffset + 4, Number(bigCreationTime));
                            }
                        } else if (version === 1 && dataOffset + 16 <= end) {
                            view.setBigUint64(dataOffset, bigCreationTime);
                            view.setBigUint64(dataOffset + 8, bigCreationTime);
                        }
                    } else if (containers.has(boxType)) {
                        patchBoxes(offset + 8, offset + boxSize);
                    }
                    offset += boxSize;
                }
            };
            patchBoxes(0, workBuffer.byteLength);
        }
        return workBuffer;
    };

    let muxer = null, encoder = null, mediaRecorder = null, mediaRecorderStopPromise = null, frameCount = 0;
    let exportWidth = 0;
    let exportHeight = 0;
    let onEncoderError = null;
    const checkCapabilities = () => !!(typeof Mp4Muxer !== 'undefined' && window.VideoEncoder && window.VideoFrame);

    applyLang(true);

    const getBestSupportedCodec = async (type, width, height, bitrate, framerate) => {
        const avcCandidates = [
            'avc1.640033',
            'avc1.64002a',
            'avc1.4d0033',
            'avc1.4d002a',
            'avc1.4DE028'
        ];
        const hevcCandidates = [
            'hvc1.1.6.L150.B0',
            'hvc1.1.6.L120.B0'
        ];

        const candidates = type === 'hevc' ? hevcCandidates : avcCandidates;

        for (const codec of candidates) {
            try {
                const support = await VideoEncoder.isConfigSupported({
                    codec, width, height, bitrate, framerate
                });
                if (support.supported) {
                    console.log(`已选择支持的编码格式: ${codec} (分辨率: ${width}x${height})`);
                    return codec;
                }
            } catch (e) {
                console.warn(`检测编码格式 ${codec} 出错:`, e);
            }
        }
        return candidates[candidates.length - 1];
    };

    const initRecorder = async (isHEVC = false) => {
        if (!supportsWebCodecs) {
            const layout = getScaledCompositeLayout(vid.videoWidth, vid.videoHeight, EXPORT_MAX_WIDTH);
            exportWidth = layout.width;
            exportHeight = layout.height;
            compositeSplitBelow = layout.splitBelow;
            cvs.width = exportWidth;
            cvs.height = exportHeight;
            cachedCanvasWidth = -1;
            cachedCanvasHeight = -1;
            textTextureInitialized = false;

            const stream = cvs.captureStream(30);
            const mimeCandidates = [
                'video/mp4;codecs="avc1.640028"',
                'video/mp4;codecs="avc1.42E01E"',
                'video/webm;codecs=vp9',
                'video/webm;codecs=vp8',
                'video/webm'
            ];
            const mime = mimeCandidates.find(type => MediaRecorder.isTypeSupported(type)) || 'video/webm';
            console.log('MediaRecorder fallback mime:', mime);
            mediaRecorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: targetBitrate });
            const chunks = [];
            mediaRecorderStopPromise = null;
            mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
            mediaRecorder.onstop = () => {
                const blob = new Blob(chunks, { type: mime });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const ext = mime.includes('webm') ? 'webm' : 'mp4';
                a.download = `${vidName}_stamp.${ext}`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                if (mediaRecorderStopPromise) {
                    mediaRecorderStopPromise.resolve();
                    mediaRecorderStopPromise = null;
                }
            };
            mediaRecorder.onerror = (event) => {
                console.warn('MediaRecorder error:', event);
                if (mediaRecorderStopPromise) {
                    mediaRecorderStopPromise.reject(new Error('MediaRecorder error'));
                    mediaRecorderStopPromise = null;
                }
            };
            mediaRecorder.start();
            return true;
        }

        if (!window.VideoEncoder) return false;

        const layout = getScaledCompositeLayout(vid.videoWidth, vid.videoHeight, EXPORT_MAX_WIDTH);
        exportWidth = layout.width;
        exportHeight = layout.height;
        compositeSplitBelow = layout.splitBelow;
        console.log(`导出直接降采样：${vid.videoWidth}×${vid.videoHeight} → ${exportWidth}×${exportHeight}`);

        cvs.width = exportWidth;
        cvs.height = exportHeight;
        cachedCanvasWidth = -1;
        cachedCanvasHeight = -1;
        textTextureInitialized = false;

        let encoderCodec = "";
        let muxerCodec = "avc";

        if (isHEVC) {
            const candidateCodec = await getBestSupportedCodec('hevc', exportWidth, exportHeight, targetBitrate, fps);
            try {
                const support = await VideoEncoder.isConfigSupported({
                    codec: candidateCodec, width: exportWidth, height: exportHeight,
                    bitrate: targetBitrate, framerate: fps
                });
                if (support.supported) {
                    encoderCodec = candidateCodec;
                    muxerCodec = "hevc";
                }
            } catch (e) { }
        }

        if (!encoderCodec) {
            encoderCodec = await getBestSupportedCodec('avc', exportWidth, exportHeight, targetBitrate, fps);
            muxerCodec = "avc";
        }

        muxer = new Mp4Muxer.Muxer({
            target: new Mp4Muxer.ArrayBufferTarget(),
            video: { codec: muxerCodec, width: exportWidth, height: exportHeight },
            fastStart: 'in-memory', firstTimestampBehavior: 'offset'
        });
        encoder = new VideoEncoder({
            output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
            error: (e) => {
                console.error("VideoEncoder error event:", e);
                if (onEncoderError) onEncoderError(e);
            }
        });
        encoder.configure({
            codec: encoderCodec, width: exportWidth, height: exportHeight,
            bitrate: targetBitrate, framerate: fps
        });
        return true;
    };

    const maybeEncode = (frame, options = {}) => {
        if (encoder && encoder.state === 'configured') {
            encoder.encode(frame, options);
        }
    };

    const startRecording = async () => {
        try {
            if (!currentParser || !window.VideoDecoder) return;
            if (vid.currentTime >= vid.duration) vid.currentTime = 0;

            const config = currentParser.getConfig();
            if (!(await initRecorder(config.type === 'hevc'))) return;

            vid.pause(); isRecording = true;
            let recordingStartTime = (vid.currentTime < 0.1) ? 0 : vid.currentTime;
            frameCount = 0; startRecBtn.disabled = true; stopRecBtn.disabled = false;
            playPauseBtn.disabled = true; timeSlider.disabled = true;

            let pendingFramesCount = 0;
            let frameProcessedResolve = null;
            const frameProcessedSignal = () => {
                if (frameProcessedResolve) { const r = frameProcessedResolve; frameProcessedResolve = null; r(); }
            };
            const waitForFrameProcessed = () => new Promise(r => { frameProcessedResolve = r; });

            currentStatusKey = 'statusPreparing'; currentStatusArg = null; currentStatusIsRec = true;
            updateStatus(t('statusPreparing'), true);
            const samples = currentParser.getSamples();

            const activeFps = (fps > 10 && fps < 100) ? fps : 36;
            const frameDurationUs = Math.round(1000000 / activeFps);
            const keyframeInterval = Math.max(1, Math.round(activeFps / 2));

            let startIdx = 0;
            if (recordingStartTime > 0) {
                const startTimeUs = recordingStartTime * 1000000;
                let lastKeyIdx = 0;
                for (let i = 0; i < samples.length; i++) {
                    if (samples[i].type === 'key') lastKeyIdx = i;
                    if (samples[i].timestamp >= startTimeUs) { startIdx = lastKeyIdx; break; }
                }
            }
            currentStatusKey = 'statusSynthesizing'; currentStatusArg = null; currentStatusIsRec = true;
            updateStatus(t('statusSynthesizing'), true);

            let lastUiUpdateTs = 0;

            await new Promise(async (resolve, reject) => {
                const cleanup = () => {
                    onEncoderError = null;
                };

                onEncoderError = (err) => {
                    cleanup();
                    reject(err);
                };

                const decoder = new VideoDecoder({
                    output: (frame) => {
                        pendingFramesCount++;
                        try {
                            if (!isRecording) { frame.close(); pendingFramesCount--; frameProcessedSignal(); return; }
                            const timeSec = frame.timestamp / 1000000;
                            if (timeSec >= recordingStartTime) {
                                drawFrame(timeSec, frame);

                                if (encoder && encoder.state === 'configured') {
                                    const pts = Math.round(frameCount * frameDurationUs);
                                    const forceKeyFrame = (frameCount % keyframeInterval) === 0;

                                    const outFrame = new VideoFrame(cvs, {
                                        timestamp: pts,
                                        duration: frameDurationUs
                                    });
                                    maybeEncode(outFrame, { keyFrame: forceKeyFrame });
                                    outFrame.close();
                                    frameCount++;

                                    const now = performance.now();
                                    if (now - lastUiUpdateTs > 100) {
                                        lastUiUpdateTs = now;
                                        currentStatusKey = 'statusSynthesizingProgress';
                                        currentStatusArg = (timeSec - recordingStartTime).toFixed(1);
                                        currentStatusIsRec = true;
                                        statusText.textContent = t('statusSynthesizingProgress', currentStatusArg);
                                        timeSlider.value = timeToSlider(timeSec, vid.duration, firstKeyFrameTime);
                                        timeDisplay.textContent = `${formatTime(timeSec)} / ${formatTime(vid.duration)}`;
                                    }
                                }
                            }
                        } catch (e) {
                            cleanup();
                            reject(e);
                        } finally {
                            frame.close();
                            pendingFramesCount--;
                            frameProcessedSignal();
                        }
                    },
                    error: (e) => {
                        cleanup();
                        reject(e);
                    }
                });

                decoder.configure({
                    codec: config.codec,
                    codedWidth: config.width,
                    codedHeight: config.height,
                    description: config.description,
                    hardwareAcceleration: 'no-preference'
                });

                const yieldMacrotask = (() => {
                    const channel = new MessageChannel();
                    const callbacks = [];
                    channel.port1.onmessage = () => {
                        const cb = callbacks.shift();
                        if (cb) cb();
                    };
                    return () => new Promise(r => {
                        callbacks.push(r);
                        channel.port2.postMessage(null);
                    });
                })();

                let hasSeenKeyFrame = false;
                for (let i = startIdx; i < samples.length; i++) {
                    if (!isRecording) break;

                    const s = samples[i];
                    const isKeyFrame = s.type === 'key';

                    if (!hasSeenKeyFrame && !isKeyFrame) {
                        continue;
                    }
                    hasSeenKeyFrame = true;

                    while (isRecording && (decoder.decodeQueueSize > 8 || (encoder && encoder.encodeQueueSize > 8))) {
                        await yieldMacrotask();
                    }

                    const sampleData = await s.loadData();
                    decoder.decode(new EncodedVideoChunk({
                        type: s.type,
                        timestamp: s.timestamp,
                        duration: s.duration,
                        data: sampleData
                    }));
                }

                if (isRecording) {
                    await decoder.flush();
                    while (pendingFramesCount > 0) {
                        await waitForFrameProcessed();
                    }
                    decoder.close();
                    cleanup();
                    await stopRecording();
                } else {
                    decoder.close();
                    cleanup();
                }
                resolve();
            });
        } catch (e) {
            console.error("Synthesis error:", e);
            currentStatusKey = 'statusError'; currentStatusArg = e.message; currentStatusIsRec = false;
            updateStatus(t('statusError', e.message));
            isRecording = false;
            if (vid) {
                const layout = getCompositeLayout(vid.videoWidth, vid.videoHeight);
                cvs.width = layout.width;
                cvs.height = layout.height;
                compositeSplitBelow = layout.splitBelow;
                cachedCanvasWidth = -1;
                cachedCanvasHeight = -1;
                textTextureInitialized = false;
            }
            startRecBtn.disabled = false;
            stopRecBtn.disabled = true;
            playPauseBtn.disabled = false;
            timeSlider.disabled = false;
        }
    };

    const stopRecording = async () => {
        isRecording = false;
        currentStatusKey = 'statusExporting'; currentStatusArg = null; currentStatusIsRec = false;
        updateStatus(t('statusExporting'));
        if (encoder && encoder.state !== 'closed') {
            try {
                await Promise.race([
                    encoder.flush(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Encoder flush timeout')), 30000))
                ]);
            } catch (e) {
                console.warn('Encoder flush 超时或出错，强制关闭:', e.message);
            }
            if (encoder.state !== 'closed') encoder.close();
        }
        if (mediaRecorder) {
            await new Promise((resolve, reject) => {
                if (mediaRecorder.state === 'recording') {
                    mediaRecorderStopPromise = { resolve, reject };
                    mediaRecorder.stop();
                } else {
                    resolve();
                }
            }).catch((e) => {
                console.warn('MediaRecorder stop failed:', e);
            });
            mediaRecorder = null;
        }
        if (muxer) {
            muxer.finalize();
            const { buffer } = muxer.target;
            let finalBuffer = patchMp4Metadata(buffer, originalMediaDate, eventLocation);
            let finalBlob = new Blob([finalBuffer], { type: 'video/mp4' });
            const file = new File([finalBlob], `${vidName}_stamp.mp4`, { type: 'video/mp4', lastModified: originalFileLastModified || Date.now() });
            const url = URL.createObjectURL(file);
            const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
            setTimeout(() => { URL.revokeObjectURL(url); currentStatusKey = 'statusDone'; currentStatusArg = null; currentStatusIsRec = false; updateStatus(t('statusDone')); }, 1000);
        }
        if (vid) {
            const layout = getCompositeLayout(vid.videoWidth, vid.videoHeight);
            cvs.width = layout.width;
            cvs.height = layout.height;
            compositeSplitBelow = layout.splitBelow;
            cachedCanvasWidth = -1;
            cachedCanvasHeight = -1;
            textTextureInitialized = false;
        }
        startRecBtn.disabled = false; stopRecBtn.disabled = true;
        playPauseBtn.disabled = false; timeSlider.disabled = false;
    };

    // --- WebGL Render Loop ---
    const drawFrame = (forcedTime = null, sourceFrame = null) => {
        if (!hasWebGL) return;
        const source = sourceFrame || vid;
        if (!source || (!sourceFrame && source.readyState < 2)) return;

        const currentTime = forcedTime ?? vid.currentTime;
        const fontStack = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

        // 1. Sync dimensions & Text Canvas sizing
        if (cvs.width !== cachedCanvasWidth || cvs.height !== cachedCanvasHeight) {
            cachedCanvasWidth = cvs.width;
            cachedCanvasHeight = cvs.height;
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

            let fontSize = cvs.width / 40;
            textCtx.font = `400 ${fontSize}px ${fontStack}`;

            const testString = "0000-00-00 00:00:00";
            const initialWidth = textCtx.measureText(testString).width;
            const targetWidthRatio = 0.285;
            const targetWidth = cvs.width * targetWidthRatio;

            if (initialWidth > 0 && initialWidth < targetWidth) {
                fontSize *= (targetWidth / initialWidth);
                textCtx.font = `400 ${fontSize}px ${fontStack}`;
            }
            cachedFontSize = fontSize;

            const bgH = Math.ceil(cachedFontSize * 2);
            textCanvas.width = cvs.width;
            textCanvas.height = bgH;
            compositeBarHeight = bgH;

            textCtx.font = `400 ${fontSize}px ${fontStack}`;
            textCtx.textBaseline = 'middle';
            cachedTextWidth = textCtx.measureText(testString).width;
            cachedSingleDigitWidth = textCtx.measureText("0").width;

            textCtx.font = `700 ${fontSize}px ${fontStack}`;
            const gearMeasuredW = textCtx.measureText("D").width;

            cachedLayout = {
                apSlotW: (fontSize * 1.15) + (cachedSingleDigitWidth * 4),
                accelSlotW: (fontSize * 2.4) + (cachedSingleDigitWidth * 4),
                brakeSlotW: fontSize * 1.05,
                blinkerSlotW: fontSize * 1.85,
                gearSlotW: gearMeasuredW,
                digitSlotW: cachedSingleDigitWidth * 3,
                unitStr: " km/h",
                unitW: textCtx.measureText(" km/h").width
            };

            textTextureInitialized = false;
            lastRenderedTimeStr = "";
        }

        // 2. Prepare Strings
        reusableDate.setTime(videoStartTime + currentTime * 1000);
        const timeStr = formatDate(reusableDate);
        let seiText = "";

        let speedVal = "--";
        let accelNum = null;
        let isBrakeOn = false;
        let apState = "NONE";
        let gearStr = "P";
        let isLeftBlinkerOn = false;
        let isRightBlinkerOn = false;
        let blinkPhase = 0;

        if (parsedFrames && parsedFrames.length > 0) {
            const frameIndex = Math.min(Math.floor(currentTime * fps), parsedFrames.length - 1);
            const frame = parsedFrames[frameIndex];
            if (frame && frame.sei) {
                const sei = frame.sei;
                const speed = Math.round((sei.vehicleSpeedMps || 0) * 3.6);
                if (enumFields && enumFields.autopilotState) {
                    apState = enumFields.autopilotState.valuesById[sei.autopilotState] || "NONE";
                }
                isBrakeOn = !!sei.brakeApplied;
                accelNum = Math.round(sei.acceleratorPedalPosition || 0);
                speedVal = speed.toString();

                const rawGear = sei.gearState !== undefined ? sei.gearState : sei.gear_state;
                if (enumFields && enumFields.gearState && enumFields.gearState.valuesById && rawGear in enumFields.gearState.valuesById) {
                    const valName = enumFields.gearState.valuesById[rawGear];
                    if (valName === "DRIVE") gearStr = "D";
                    else if (valName === "REVERSE") gearStr = "R";
                    else if (valName === "NEUTRAL") gearStr = "N";
                    else if (valName === "PARK") gearStr = "P";
                } else if (typeof rawGear === 'number') {
                    if (rawGear === 1) gearStr = "D";
                    else if (rawGear === 2) gearStr = "R";
                    else if (rawGear === 3) gearStr = "N";
                    else gearStr = "P";
                } else if (typeof rawGear === 'string') {
                    if (rawGear.includes("DRIVE")) gearStr = "D";
                    else if (rawGear.includes("REVERSE")) gearStr = "R";
                    else if (rawGear.includes("NEUTRAL")) gearStr = "N";
                    else gearStr = "P";
                }

                isLeftBlinkerOn = !!(sei.blinkerOnLeft || sei.blinker_on_left);
                isRightBlinkerOn = !!(sei.blinkerOnRight || sei.blinker_on_right);
                blinkPhase = (isLeftBlinkerOn || isRightBlinkerOn) ? (Math.floor(currentTime * 3) % 2) : 0;

                seiText = `${speedVal}|${accelNum}|${isBrakeOn}|${apState}|${gearStr}|${isLeftBlinkerOn}|${isRightBlinkerOn}|${blinkPhase}`;
            }
        }

        // 3. Update Text Texture ONLY if strings changed
        if (timeStr !== lastRenderedTimeStr || seiText !== lastRenderedSeiStr) {
            const bgH = textCanvas.height;
            textCtx.clearRect(0, 0, textCanvas.width, bgH);

            const pad = cachedFontSize * 0.5;
            const innerLeft = pad;
            const innerRight = cvs.width - pad;

            textCtx.fillStyle = '#1a1a1a';
            textCtx.fillRect(0, 0, cvs.width, bgH);

            const centerY = bgH * 0.5;
            textCtx.font = `400 ${cachedFontSize}px ${fontStack}`;
            const textCenterY = TelemetryRenderer.getVisualTextY(textCtx, centerY, "0");
            const seiGap = cachedFontSize * 1.5;

            // Date/Time
            textCtx.fillStyle = '#d1d1d1';
            textCtx.textAlign = 'left';
            textCtx.fillText(timeStr, innerLeft, textCenterY);

            const L = cachedLayout;
            const apSlotW = L.apSlotW;
            const accelSlotW = L.accelSlotW;
            const brakeSlotW = L.brakeSlotW;
            const blinkerSlotW = L.blinkerSlotW;
            const gearSlotW = L.gearSlotW;
            const digitSlotW = L.digitSlotW;
            const unitStr = L.unitStr;
            const unitW = L.unitW;
            const speedSlotW = digitSlotW + unitW;

            const apX = innerRight - apSlotW;
            const accelX = apX - seiGap - accelSlotW;
            const brakeX = accelX - seiGap - brakeSlotW;
            const blinkerX = brakeX - seiGap - blinkerSlotW;
            const gearX = blinkerX - seiGap - gearSlotW;
            const speedX = gearX - seiGap - speedSlotW;

            // Render Tesla Vector Controls
            TelemetryRenderer.drawTeslaAP(textCtx, apX, centerY, cachedFontSize, apState, fontStack);
            TelemetryRenderer.drawTeslaAccel(textCtx, accelX, centerY, cachedFontSize, accelNum, fontStack);
            TelemetryRenderer.drawTeslaBrake(textCtx, brakeX, centerY, cachedFontSize, isBrakeOn);
            TelemetryRenderer.drawTeslaBlinkers(textCtx, blinkerX, centerY, cachedFontSize, isLeftBlinkerOn, isRightBlinkerOn, blinkPhase);
            TelemetryRenderer.drawTeslaGear(textCtx, gearX, centerY, cachedFontSize, gearStr, fontStack);

            // Speed
            textCtx.font = `400 ${cachedFontSize}px ${fontStack}`;
            textCtx.textAlign = 'left';
            textCtx.textBaseline = 'middle';
            textCtx.fillStyle = '#d1d1d1';
            textCtx.fillText(unitStr, speedX + digitSlotW, textCenterY);
            textCtx.textAlign = 'right';
            textCtx.fillText(speedVal, speedX + digitSlotW, textCenterY);

            lastRenderedTimeStr = timeStr;
            lastRenderedSeiStr = seiText;

            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, textTexture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

            if (!textTextureInitialized) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
                textTextureInitialized = true;
            } else {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
            }
        }

        // 4. Upload Video Frame
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, videoTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

        // 5. Render WebGL Composite
        gl.useProgram(program);
        gl.bindVertexArray(vao);

        gl.uniform1i(videoTexLoc, 0);
        gl.uniform1i(textTexLoc, 1);

        if (compositeSplitBelow) {
            const videoViewportHeight = Math.max(1, gl.drawingBufferHeight - compositeBarHeight);
            gl.viewport(0, compositeBarHeight, gl.drawingBufferWidth, videoViewportHeight);
            gl.uniform1f(barRatioLoc, 0.0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            gl.viewport(0, 0, gl.drawingBufferWidth, compositeBarHeight);
            gl.uniform1f(barRatioLoc, 1.0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } else {
            const barRatio = cachedCanvasHeight > 0 ? (textCanvas.height / cachedCanvasHeight) : 0;
            gl.uniform1f(barRatioLoc, barRatio);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }

        gl.bindVertexArray(null);

        if (isRecording) {
            gl.flush();
        }
    };

    let lastVidTime = -1;
    let lastVidTimeUpdate = 0;

    const render = () => {
        if (animationId) cancelAnimationFrame(animationId);
        if (!vid || isRecording) {
            animationId = null;
            return;
        }

        if (!dragging) {
            timeSlider.value = timeToSlider(vid.currentTime, vid.duration, firstKeyFrameTime);
        }
        timeDisplay.textContent = `${formatTime(vid.currentTime)} / ${formatTime(vid.duration)}`;

        const now = Date.now();
        if (!vid.paused && !document.hidden) {
            if (vid.currentTime === lastVidTime) {
                if (now - lastVidTimeUpdate > 500) {
                    vid.currentTime += 0.005;
                    lastVidTimeUpdate = now;
                    console.log("检测到视频管线卡死，执行看门狗唤醒...");
                }
            } else {
                lastVidTime = vid.currentTime;
                lastVidTimeUpdate = now;
            }
        } else {
            lastVidTime = -1;
        }

        drawFrame();
        const keepGoing = !vid.paused || playPending;
        if (!vid.paused) playPending = false;
        animationId = (!isRecording && keepGoing) ? requestAnimationFrame(render) : null;
    };

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        if (vid && !isRecording) {
            if (!vid.paused) {
                vid.play().catch(() => { });
                vid.currentTime += 0.005;
            }
            lastVidTimeUpdate = Date.now();
            render();
        }
    });

    const handleFile = async (file) => {
        if (!file) return;
        const isVideo = file.type.startsWith('video/') || file.name.match(/\.(mp4|mov|m4v)$/i);
        if (!isVideo) return;

        videoStartTime = 0;
        parsedFrames = [];
        currentParser = null;
        firstPlayLock = true;
        firstKeyFrameTime = 0;
        if (vid) {
            vid.pause();
            if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
        }

        syncPlayButton(true);
        fps = 36;
        cachedCanvasWidth = -1; cachedCanvasHeight = -1;
        textTextureInitialized = false;

        videoViewer.style.display = "block"; dropZone.style.display = "none";
        currentStatusKey = 'statusParsing'; currentStatusArg = null; currentStatusIsRec = false;
        updateStatus(t('statusParsing'));

        vidName = file.name.substring(0, file.name.lastIndexOf('.'));
        originalFileLastModified = file.lastModified;

        const dateMatch = file.name.match(/(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/);

        try {
            const buffer = await file.arrayBuffer();
            const protobufData = await DashcamHelpers.initProtobuf();
            enumFields = protobufData.enumFields;
            currentParser = new DashcamMP4(buffer);
            parsedFrames = await currentParser.parseFrames(protobufData.SeiMetadata);

            try {
                const allSamples = currentParser.getSamples();
                for (const s of allSamples) {
                    if (s.type === 'key') {
                        firstKeyFrameTime = s.timestamp / 1000000;
                        break;
                    }
                }
                if (firstKeyFrameTime > 0.02) {
                    console.log(`检测到视频首帧非关键帧，首个关键帧位于 ${firstKeyFrameTime.toFixed(3)}s，将 seek 到该位置以避免 iOS Safari 黑屏`);
                }
            } catch (e) { }

            try {
                const config = currentParser.getConfig();
                if (config.durations && config.durations.length > 0) {
                    const totalDurationMs = config.durations.reduce((a, b) => a + b, 0);
                    if (totalDurationMs > 0) fps = Math.round(config.durations.length / (totalDurationMs / 1000));
                    const samples = currentParser.getSamples();
                    const totalVideoBytes = samples.reduce((sum, s) => sum + s.size, 0);
                    const durationSec = totalDurationMs / 1000;
                    const originalBitrate = Math.round((totalVideoBytes * 8) / durationSec);
                    const exportW = Math.min(config.width, EXPORT_MAX_WIDTH);
                    const scaleRatio = exportW / config.width;
                    const retentionRatio = scaleRatio < 1.0 ? Math.max(0.8, scaleRatio) : 1.0;
                    const iosMultiplier = isIOSDevice() ? 2.0 : 1.0;
                    const optimalBitrate = Math.round(originalBitrate * retentionRatio * iosMultiplier);
                    const minBitrate = Math.round(5000000 * iosMultiplier);
                    const maxBitrate = Math.round(15000000 * iosMultiplier);
                    targetBitrate = Math.max(minBitrate, Math.min(optimalBitrate, maxBitrate));
                    console.log(`码率计算 [设备=${isIOSDevice() ? 'iOS (系数 2.0x)' : 'Windows/其他 (1.0x)'}]：原始码率=${(originalBitrate / 1000000).toFixed(2)}M, 导出目标码率=${(targetBitrate / 1000000).toFixed(2)}M`);
                }
            } catch (e) {
                const iosMultiplier = isIOSDevice() ? 2.0 : 1.0;
                targetBitrate = Math.round(5000000 * iosMultiplier);
            }

            const firstSei = parsedFrames.find(f => f.sei)?.sei;
            const mp4CreationTime = currentParser.getCreationTime();
            let timeBaseSource = "fallback";

            if (firstSei && firstSei.frameSeqNo) {
                const seq = Number(firstSei.frameSeqNo);
                if (seq > 1000000000000) {
                    videoStartTime = seq;
                    timeBaseSource = "SEI 毫秒级时间戳";
                } else if (seq > 1000000000) {
                    videoStartTime = seq * 1000;
                    timeBaseSource = "SEI 秒级时间戳";
                }
            }

            if (!videoStartTime && dateMatch) {
                videoStartTime = new Date(`${dateMatch[1].replace(/-/g, '/')} ${dateMatch[2].replace(/-/g, ':')}`).getTime();
                timeBaseSource = "文件名日期";
            }

            if (!videoStartTime) {
                if (mp4CreationTime) {
                    videoStartTime = mp4CreationTime;
                    timeBaseSource = "MP4 头部创建时间";
                } else {
                    videoStartTime = originalFileLastModified || Date.now();
                    timeBaseSource = originalFileLastModified ? "文件最后修改时间" : "当前系统时间";
                }
            }
            console.log(`时间基准确定：${timeBaseSource} (${videoStartTime})`);
            originalMediaDate = Math.floor(videoStartTime / 1000) + MP4_EPOCH_OFFSET;
        } catch (e) {
            console.error("解析遥测数据失败", e);
            parsedFrames = [];
            if (!videoStartTime) videoStartTime = originalFileLastModified || Date.now();
        }

        currentStatusKey = 'statusLoading'; currentStatusArg = null; currentStatusIsRec = false;
        updateStatus(t('statusLoading'));
        const nextVid = createFreshVideo();
        let isReady = false;
        let dimensionsSet = false;
        let wxBridgeHandler = null;
        let isSeeking = false;

        const onReady = () => {
            if (nextVid.readyState < 1 && !nextVid.videoWidth) return;

            if (!dimensionsSet && nextVid.videoWidth) {
                const layout = getCompositeLayout(nextVid.videoWidth, nextVid.videoHeight);
                cvs.width = layout.width;
                cvs.height = layout.height;
                compositeSplitBelow = layout.splitBelow;
                cachedCanvasWidth = -1;
                cachedCanvasHeight = -1;
                textTextureInitialized = false;

                const totalPx = nextVid.videoWidth * nextVid.videoHeight;
                scrubThrottleMs = totalPx > 2000000 ? 50 : 16;

                dimensionsSet = true;
            }

            if (isReady) return;
            if (isSeeking) return;
            if (!nextVid.paused) return;

            const seekTarget = firstKeyFrameTime > 0.02 ? firstKeyFrameTime : 0;
            const needsSeek = seekTarget > 0
                ? Math.abs(nextVid.currentTime - seekTarget) > 0.05
                : nextVid.currentTime > 0.1;

            if (needsSeek) {
                nextVid.pause();
                isSeeking = true;
                nextVid.currentTime = seekTarget;
                return;
            }

            // drawFrame() requires readyState >= 2 (HAVE_CURRENT_DATA) to render.
            // When firstKeyFrameTime=0 (keyframe at frame 0), no seek is needed,
            // so onReady() may fire from onloadedmetadata (readyState=1) before the
            // decoder has a frame to display. Wait for oncanplay (readyState>=2).
            if (nextVid.readyState < 2) return;

            isReady = true;
            firstPlayTargetTime = firstKeyFrameTime > 0.02 ? firstKeyFrameTime : 0;
            if (wxBridgeHandler) {
                document.removeEventListener('WeixinJSBridgeReady', wxBridgeHandler);
                wxBridgeHandler = null;
            }

            startRecBtn.disabled = !checkCapabilities();
            currentStatusKey = 'statusReady'; currentStatusArg = null; currentStatusIsRec = false;
            updateStatus(t('statusReady'));

            render();
        };

        nextVid.onloadedmetadata = onReady;
        nextVid.oncanplay = onReady;
        nextVid.onprogress = () => { if (nextVid.readyState >= 1 || nextVid.videoWidth) onReady(); };
        nextVid.onplay = () => {
            syncPlayButton(false);
            onReady();
            if (!isRecording) render();
        };
        nextVid.onpause = () => {
            syncPlayButton(true);
            onReady();
        };
        nextVid.onseeked = () => {
            isSeeking = false;
            onReady();
            if (nextVid.paused) render();
        };
        nextVid.onended = () => { syncPlayButton(true); animationId = null; };

        const handleStall = () => { if (!nextVid.paused && !isRecording) nextVid.currentTime += 0.005; };
        nextVid.onwaiting = handleStall;
        nextVid.onstalled = handleStall;

        currentVideoUrl = URL.createObjectURL(file);
        nextVid.src = currentVideoUrl;
        vid = nextVid;
        nextVid.load();

        const tryActivate = (doLoad = false) => {
            if (isReady) return;
            try {
                if (doLoad) nextVid.load();
                // iOS Safari: calling play() without user gesture rejects but may still trigger
                // the media pipeline to start buffering/decoding, causing currentTime to drift
                // even while the video appears paused. Use load()+events only on iOS.
                if (isIOSDevice()) {
                    // On iOS, rely purely on loadedmetadata/canplay events for readiness.
                    // load() is enough to kick off the media pipeline without the play() side effects.
                    if (doLoad) nextVid.load();
                    return;
                }
                const p = nextVid.play();
                if (p && typeof p.then === 'function') {
                    p.then(() => {
                        nextVid.pause();
                    }).catch(() => {
                        if (nextVid.readyState >= 1 || nextVid.videoWidth) onReady();
                    });
                } else {
                    // Older browser: play() returns undefined, ensure video is paused
                    setTimeout(() => { nextVid.pause(); }, 100);
                }
            } catch (e) { }
        };

        tryActivate();
        if (typeof WeixinJSBridge !== 'undefined') {
            WeixinJSBridge.invoke('getNetworkType', {}, () => tryActivate(true));
        }
        wxBridgeHandler = () => tryActivate(true);
        document.addEventListener('WeixinJSBridgeReady', wxBridgeHandler, { once: true });
        fileInput.value = "";
    };

    const handleFiles = async (fileList) => {
        if (!fileList || fileList.length === 0) return;

        let videoFile = null;
        let jsonFile = null;

        for (let i = 0; i < fileList.length; i++) {
            const f = fileList[i];
            const isVideo = f.type.startsWith('video/') || f.name.match(/\.(mp4|mov|m4v)$/i);
            const isJson = f.name.toLowerCase().endsWith('.json') || f.type === 'application/json';
            if (isVideo && !videoFile) {
                videoFile = f;
            } else if (isJson && !jsonFile) {
                jsonFile = f;
            }
        }

        if (jsonFile) {
            try {
                const text = await jsonFile.text();
                const data = JSON.parse(text);
                const lat = data.est_lat !== undefined ? data.est_lat : data.latitude;
                const lon = data.est_lon !== undefined ? data.est_lon : data.longitude;
                if (lat !== undefined && lon !== undefined && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lon))) {
                    eventLocation = {
                        lat: parseFloat(lat),
                        lon: parseFloat(lon)
                    };
                    console.log("已成功读取 event.json 坐标:", eventLocation);
                } else {
                    eventLocation = null;
                }
            } catch (e) {
                console.warn("读取 event.json 失败:", e);
                eventLocation = null;
            }
        } else {
            eventLocation = null;
        }

        if (videoFile) {
            await handleFile(videoFile);
        }
    };

    if (fileInput) fileInput.onchange = (e) => handleFiles(e.target.files);
    if (dropZone) {
        dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add("active"); };
        dropZone.ondragleave = () => dropZone.classList.remove("active");
        dropZone.ondrop = (e) => { e.preventDefault(); dropZone.classList.remove("active"); handleFiles(e.dataTransfer.files); };
    }

    const togglePlay = () => {
        if (!vid || isRecording) return;
        if (vid.paused) {
            const doPlay = () => {
                dragging = false;
                vid.play().catch(() => { syncPlayButton(true); });
                playPending = true;
                if (animationId === null) animationId = requestAnimationFrame(render);
            };

            if (firstPlayLock) {
                firstPlayLock = false;
                const targetTime = firstPlayTargetTime || Math.max(0, firstKeyFrameTime);
                // Always seek to the correct start position on first play.
                // Never trust vid.currentTime — on iOS Safari it can drift after import
                // due to internal media pipeline buffering even while paused.

                // Fast path: already at target (common case after tryActivate fix).
                // Avoids waiting for a seeked event that will never fire because
                // setting currentTime to its current value is a no-op.
                if (Math.abs(vid.currentTime - targetTime) < 0.1) {
                    doPlay();
                } else {
                    let resolved = false;
                    let seekRetryCount = 0;
                    const MAX_SEEK_RETRIES = 3;
                    const resolvePlay = () => {
                        if (resolved) return;
                        // Verify seek actually took effect; on iOS the seeked event may
                        // fire before the decoder position is actually updated.
                        if (Math.abs(vid.currentTime - targetTime) > 0.25 && seekRetryCount < MAX_SEEK_RETRIES) {
                            seekRetryCount++;
                            vid.currentTime = targetTime;
                            return;
                        }
                        resolved = true;
                        vid.removeEventListener('seeked', resolvePlay);
                        // Final safety: force currentTime to target before playing
                        if (vid.currentTime !== targetTime) {
                            vid.currentTime = targetTime;
                        }
                        doPlay();
                    };
                    vid.addEventListener('seeked', resolvePlay);
                    vid.currentTime = targetTime;
                    // Safety timeout much longer than 200ms — iOS may take 1-2s to complete seek.
                    // If seeked never fires (e.g. video not loaded enough), fall back after 5s.
                    setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            vid.removeEventListener('seeked', resolvePlay);
                            vid.currentTime = targetTime;
                            doPlay();
                        }
                    }, 5000);
                }
            } else {
                doPlay();
            }
        } else {
            vid.pause();
        }
    };

    if (cvs) cvs.onclick = togglePlay;
    if (playPauseBtn) playPauseBtn.onclick = togglePlay;
    if (startRecBtn) startRecBtn.onclick = startRecording;
    if (stopRecBtn) stopRecBtn.onclick = stopRecording;
    if (reselectBtn) reselectBtn.onclick = () => fileInput.click();

    let scrubTarget = null;
    let scrubRaf = null;
    let lastScrubTime = 0;
    const scrubLoop = () => {
        scrubRaf = null;
        if (!dragging || scrubTarget === null) return;
        const now = performance.now();
        if (now - lastScrubTime < scrubThrottleMs) {
            scrubRaf = requestAnimationFrame(scrubLoop);
            return;
        }
        lastScrubTime = now;
        const target = scrubTarget;
        scrubTarget = null;
        vid.currentTime = target;
        requestAnimationFrame(() => render());
        if (dragging) scrubRaf = requestAnimationFrame(scrubLoop);
    };

    if (timeSlider) {
        timeSlider.oninput = () => {
            dragging = true;
            const previewTime = sliderToTime(timeSlider.value, vid.duration, firstKeyFrameTime);
            timeDisplay.textContent = `${formatTime(previewTime)} / ${formatTime(vid.duration)}`;
            scrubTarget = sliderToTime(timeSlider.value, vid.duration, firstKeyFrameTime);
            if (!scrubRaf) {
                lastScrubTime = 0;
                scrubRaf = requestAnimationFrame(scrubLoop);
            }
        };

        timeSlider.onchange = () => {
            if (scrubRaf) { cancelAnimationFrame(scrubRaf); scrubRaf = null; }
            scrubTarget = null;
            firstPlayLock = false;
            vid.currentTime = sliderToTime(timeSlider.value, vid.duration, firstKeyFrameTime);
            dragging = false;
            render();
        };
    }

    window.onload = () => {
        if (!checkCapabilities()) {
            currentStatusKey = 'statusNoSupport'; currentStatusArg = null; currentStatusIsRec = false;
            updateStatus(t('statusNoSupport'));
        }
    };
})();
