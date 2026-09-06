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

    // Slider 使用全局连续时间轴映射（见 computeMergedTimeline / globalTimeToSlider）
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
    let videoTextureInitialized = false;
    let videoTexWidth = 0;
    let videoTexHeight = 0;

    let vid = null;
    let dragging = false;
    let vidName = "tesla_dashcam";
    let videoStartTime = 0;
    let isRecording = false;
    let startRequestPending = false; // 合成启动锁：initRecorder 含多次 await，防止重复进入
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

    // 多片段合并状态
    let clips = [];
    let currentClipContext = null;
    let mergeAnalysis = null;
    let previewClipIndex = 0;

    // 全局连续时间轴（跨段合并进度条用）
    let mergedOffsets = [0];      // mergedOffsets[i] = 第 i 段起点（秒，相对首段 0）
    let mergedTotalDuration = 0;  // 全部片段累计时长（秒）
    let pendingSeekTime = null;   // 切换片段后待定位的局部时间（秒），用于跨段拖动 seek
    let pendingClipSwitch = null; // 跨段拖动过程中正在切换到的片段索引，避免重复触发 setupPreview

    const computeMergedTimeline = () => {
        mergedOffsets = [0];
        let acc = 0;
        for (const c of clips) { acc += (c.durationMs || 0) / 1000; mergedOffsets.push(acc); }
        mergedTotalDuration = acc;
    };
    const globalTimeToSlider = (gt) => {
        if (mergedTotalDuration <= 0) return 0;
        return Math.max(0, Math.min(1, gt / mergedTotalDuration)) * 1000;
    };
    const sliderToGlobalTime = (val) => (val / 1000) * mergedTotalDuration;
    const findClipForGlobalTime = (gt) => {
        for (let i = 0; i < clips.length; i++) {
            const start = mergedOffsets[i];
            const end = mergedOffsets[i + 1];
            if (gt < end - 1e-6 || i === clips.length - 1) {
                return { i, localTime: Math.max(0, gt - start) };
            }
        }
        return { i: Math.max(0, clips.length - 1), localTime: 0 };
    };

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

    const computeTargetBitrate = (clip) => {
        const iosMultiplier = isIOSDevice() ? 2.0 : 1.0;
        const exportW = Math.min(clip.width, EXPORT_MAX_WIDTH);
        const scaleRatio = exportW / clip.width;
        const retentionRatio = scaleRatio < 1.0 ? Math.max(0.8, scaleRatio) : 1.0;
        const optimalBitrate = Math.round(clip.originalBitrate * retentionRatio * iosMultiplier);
        const minBitrate = Math.round(5000000 * iosMultiplier);
        const maxBitrate = Math.round(15000000 * iosMultiplier);
        return Math.max(minBitrate, Math.min(optimalBitrate, maxBitrate));
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
        const workBuffer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
        const view = new DataView(workBuffer);

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

        // 1. 原位修补创建时间（mvhd, tkhd, mdhd 均位于 moov 内部，仅扫描 moov 结构大幅减少开销）
        if (creationTime) {
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
                    let boxSize = view.getUint32(offset);
                    const boxType = view.getUint32(offset + 4);
                    let headerSize = 8;
                    if (boxSize === 1 && offset + 16 <= end) {
                        const high = view.getUint32(offset + 8);
                        const low = view.getUint32(offset + 12);
                        boxSize = Number((BigInt(high) << 32n) | BigInt(low));
                        headerSize = 16;
                    } else if (boxSize === 0) {
                        boxSize = end - offset;
                    }
                    if (boxSize < headerSize || offset + boxSize > end) break;

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
                        patchBoxes(offset + headerSize, offset + boxSize);
                    }
                    offset += boxSize;
                }
            };

            if (moovInfo) {
                patchBoxes(moovInfo.start + moovInfo.headerSize, moovInfo.end);
            } else {
                patchBoxes(0, workBuffer.byteLength);
            }
        }

        // 2. 原位修补 GPS 地理坐标元数据（直接在原 buffer 上更新 moov 尺寸与 chunk offsets）
        let extraBytes = null;
        if (location && location.lat !== undefined && location.lon !== undefined && moovInfo) {
            const isoStr = formatISO6709(location.lat, location.lon);
            if (isoStr) {
                const metaBox = buildLocationMetaBox(isoStr);
                const udtaBox = buildLocationUdtaBox(isoStr);
                const extraLength = metaBox.length + udtaBox.length;
                extraBytes = new Uint8Array(extraLength);
                extraBytes.set(metaBox, 0);
                extraBytes.set(udtaBox, metaBox.length);

                const deltaSize = extraLength;
                const isMdatAfterMoov = mdatInfo && mdatInfo.start > moovInfo.start;

                if (isMdatAfterMoov) {
                    const adjustChunkOffsets = (start, end) => {
                        let offset = start;
                        while (offset + 8 <= end) {
                            let boxSize = view.getUint32(offset);
                            const boxType = view.getUint32(offset + 4);
                            let headerSize = 8;
                            if (boxSize === 1 && offset + 16 <= end) {
                                const high = view.getUint32(offset + 8);
                                const low = view.getUint32(offset + 12);
                                boxSize = Number((BigInt(high) << 32n) | BigInt(low));
                                headerSize = 16;
                            } else if (boxSize === 0) {
                                boxSize = end - offset;
                            }
                            if (boxSize < headerSize || offset + boxSize > end) break;

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
                                adjustChunkOffsets(offset + headerSize, offset + boxSize);
                            }
                            offset += boxSize;
                        }
                    };
                    adjustChunkOffsets(moovInfo.start + moovInfo.headerSize, moovInfo.end);
                }

                // 原位更新 moov 大小
                view.setUint32(moovInfo.start, moovInfo.size + deltaSize);
            }
        }

        // 3. 组装零拷贝 Blob（杜绝创建双倍超大 ArrayBuffer 避免移动端 OOM）
        let blobParts;
        if (extraBytes && moovInfo) {
            if (moovInfo.end >= workBuffer.byteLength) {
                // moov 位于文件末尾（fastStart: false 默认模式），直接拼接原 buffer 与尾部追加字节
                blobParts = [workBuffer, extraBytes];
            } else {
                // moov 位于文件前端（fastStart: true 模式），使用 Uint8Array 零拷贝视图切片
                blobParts = [
                    new Uint8Array(workBuffer, 0, moovInfo.end),
                    extraBytes,
                    new Uint8Array(workBuffer, moovInfo.end)
                ];
            }
        } else {
            blobParts = [workBuffer];
        }

        return new Blob(blobParts, { type: 'video/mp4' });
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

    const initRecorder = async (isHEVC = false, srcWidth = null, srcHeight = null, framerate = null) => {
        // 导出帧率必须与 PTS 计算所用的帧率一致（见 startRecording 的 activeFps）。
        // 不能直接用全局 fps：它由 setupPreview 设为「当前预览片段」的帧率，
        // 多段合并且各段 fps 不同时会导致输出时长/播放速度错误。
        const exportFps = (typeof framerate === 'number' && framerate > 0) ? framerate : fps;

        if (!supportsWebCodecs) {
            const layout = getScaledCompositeLayout(
                srcWidth != null ? srcWidth : (vid ? vid.videoWidth : 0),
                srcHeight != null ? srcHeight : (vid ? vid.videoHeight : 0),
                EXPORT_MAX_WIDTH
            );
            exportWidth = layout.width;
            exportHeight = layout.height;
            compositeSplitBelow = layout.splitBelow;
            if (cvs.width !== exportWidth || cvs.height !== exportHeight) {
                cvs.width = exportWidth;
                cvs.height = exportHeight;
            }
            cachedCanvasWidth = -1;
            cachedCanvasHeight = -1;
            textTextureInitialized = false;

            const stream = cvs.captureStream(exportFps);
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

        const inWidth = srcWidth != null ? srcWidth : (vid ? vid.videoWidth : 0);
        const inHeight = srcHeight != null ? srcHeight : (vid ? vid.videoHeight : 0);
        const layout = getScaledCompositeLayout(inWidth, inHeight, EXPORT_MAX_WIDTH);
        exportWidth = layout.width;
        exportHeight = layout.height;
        compositeSplitBelow = layout.splitBelow;
        console.log(`导出直接降采样：${inWidth}×${inHeight} → ${exportWidth}×${exportHeight}`);

        // 仅在分辨率变化时重置画布（重置会清空内容）；分辨率不变则保留预览帧，避免合成开头黑屏闪烁
        if (cvs.width !== exportWidth || cvs.height !== exportHeight) {
            cvs.width = exportWidth;
            cvs.height = exportHeight;
        }
        cachedCanvasWidth = -1;
        cachedCanvasHeight = -1;
        textTextureInitialized = false;

        let encoderCodec = "";
        let muxerCodec = "avc";

        if (isHEVC) {
            const candidateCodec = await getBestSupportedCodec('hevc', exportWidth, exportHeight, targetBitrate, exportFps);
            try {
                const support = await VideoEncoder.isConfigSupported({
                    codec: candidateCodec, width: exportWidth, height: exportHeight,
                    bitrate: targetBitrate, framerate: exportFps
                });
                if (support.supported) {
                    encoderCodec = candidateCodec;
                    muxerCodec = "hevc";
                }
            } catch (e) { }
        }

        if (!encoderCodec) {
            encoderCodec = await getBestSupportedCodec('avc', exportWidth, exportHeight, targetBitrate, exportFps);
            muxerCodec = "avc";
        }

        muxer = new Mp4Muxer.Muxer({
            target: new Mp4Muxer.ArrayBufferTarget(),
            video: { codec: muxerCodec, width: exportWidth, height: exportHeight },
            // 不使用 'in-memory'：它会在 finalize 时把整个文件重排到一份新 buffer，
            // 使导出峰值内存翻倍（数百 MB）。moov 位于尾部的 MP4 本地播放完全正常。
            fastStart: false, firstTimestampBehavior: 'offset'
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
            bitrate: targetBitrate, framerate: exportFps
        });
        return true;
    };

    const maybeEncode = (frame, options = {}) => {
        if (encoder && encoder.state === 'configured') {
            encoder.encode(frame, options);
        }
    };

    const startRecording = async () => {
        // 竞态防护：initRecorder 内部有多次 await（编码器能力检测），在此期间
        // startRecBtn 尚未禁用、isRecording 尚未置位，重复点击会并发启动多个合成流程，
        // 导致多个 VideoEncoder 写入同一个 muxer，输出文件损坏。
        if (startRequestPending || isRecording) return;
        startRequestPending = true;
        try {
            if (!clips || clips.length === 0 || !window.VideoDecoder) return;
            const isMerge = clips.length > 1;
            const refClip = clips[0];
            if (!isMerge && vid && vid.currentTime >= vid.duration) vid.currentTime = 0;

            const isHEVC = refClip.config.codec === 'hevc';
            // 首段帧率即本次合成的基准帧率，编码器配置与 PTS 计算共用同一个值
            const activeFps = (refClip.fps > 10 && refClip.fps < 100) ? refClip.fps : 36;
            startRecBtn.disabled = true;
            if (!(await initRecorder(isHEVC, refClip.config.width, refClip.config.height, activeFps))) {
                updateStartButtonState();
                return;
            }

            if (vid) vid.pause();

            // 合成起点：首段预览时允许从当前播放进度开始；但首帧非关键帧的视频在首个
            // 关键帧之前无法呈现画面（会黑屏），故合成起点不得早于首个关键帧。
            let recordingStartTime;
            if (previewClipIndex === 0) {
                const desired = (vid && vid.currentTime >= 0.1) ? vid.currentTime : 0;
                recordingStartTime = (firstKeyFrameTime > 0.02) ? Math.max(desired, firstKeyFrameTime) : desired;
            } else {
                recordingStartTime = 0;
            }

            // 预填充画布：用已呈现的当前预览帧铺底，消除解码预热期黑屏闪烁。
            // 首帧非关键帧时对齐到首个关键帧再绘制，并用 requestVideoFrameCallback 确保
            // 拿到的是「已呈现」的有效帧，而不是刚 seek 完尚未绘制的黑屏。
            const prefillTime = recordingStartTime;
            const drawPrefill = () => {
                try { if (vid && vid.readyState >= 2 && hasWebGL) drawFrame(prefillTime, vid); } catch (e) { }
            };
            if (vid && vid.readyState >= 2 && hasWebGL) {
                if (vid.currentTime < prefillTime - 0.05) {
                    if (vid.requestVideoFrameCallback) {
                        vid.requestVideoFrameCallback(drawPrefill);
                    } else {
                        const onSeek = () => { vid.removeEventListener('seeked', onSeek); drawPrefill(); };
                        vid.addEventListener('seeked', onSeek);
                    }
                    vid.currentTime = prefillTime;
                } else {
                    drawPrefill();
                    if (vid.requestVideoFrameCallback) vid.requestVideoFrameCallback(drawPrefill);
                }
            }
            isRecording = true;
            frameCount = 0; stopRecBtn.disabled = false;
            playPauseBtn.disabled = true; timeSlider.disabled = true;

            let pendingFramesCount = 0;
            let frameProcessedResolve = null;
            const frameProcessedSignal = () => {
                if (frameProcessedResolve) { const r = frameProcessedResolve; frameProcessedResolve = null; r(); }
            };
            const waitForFrameProcessed = () => new Promise(r => { frameProcessedResolve = r; });

            currentStatusKey = 'statusPreparing'; currentStatusArg = null; currentStatusIsRec = true;
            updateStatus(t('statusPreparing'), true);

            const frameDurationUs = Math.round(1000000 / activeFps);
            const keyframeInterval = Math.max(1, Math.round(activeFps / 2));

            currentStatusKey = 'statusSynthesizing'; currentStatusArg = null; currentStatusIsRec = true;
            updateStatus(t('statusSynthesizing'), true);

            let lastUiUpdateTs = 0;

            await new Promise(async (resolve, reject) => {
                const cleanup = () => { onEncoderError = null; };
                onEncoderError = (err) => { cleanup(); reject(err); };

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

                const processClip = async (clip, clipOrdinal) => {
                    currentClipContext = clip;
                    const config = clip.config;
                    const samples = clip.samples;
                    // 多段或拼接段的后续片段一律从头开始；仅首段单文件合成允许跳到录制起点
                    const skipBefore = (clipOrdinal > 0) ? 0 : recordingStartTime;

                    const decoder = new VideoDecoder({
                        output: (frame) => {
                            pendingFramesCount++;
                            try {
                                if (!isRecording) { frame.close(); pendingFramesCount--; frameProcessedSignal(); return; }
                                const timeSec = frame.timestamp / 1000000;
                                if (timeSec >= skipBefore) {
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
                                            const relSec = (clip.videoStartTime - refClip.videoStartTime) / 1000 + timeSec;
                                            currentStatusArg = relSec.toFixed(1);
                                            currentStatusIsRec = true;
                                        statusText.textContent = t('statusSynthesizingProgress', currentStatusArg)
                                            + (isMerge ? ` (${clipOrdinal + 1}/${clips.length})` : '');
                                        // 合成进度条跨段连续：全局时间 = 该段偏移 + 段内时间
                                        const gt = mergedOffsets[clipOrdinal] + timeSec;
                                        timeSlider.value = globalTimeToSlider(gt);
                                        timeDisplay.textContent = `${formatTime(gt)} / ${formatTime(mergedTotalDuration)}`;
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
                        error: (e) => { cleanup(); reject(e); }
                    });

                    decoder.configure({
                        codec: config.codec,
                        codedWidth: config.width,
                        codedHeight: config.height,
                        description: config.description,
                        hardwareAcceleration: 'no-preference'
                    });

                    let hasSeenKeyFrame = false;
                    let startIdx = 0;
                    if (clipOrdinal === 0) {
                        // 首段始终从首个关键帧开始解码，避免首帧非关键帧导致的黑屏/绿屏
                        for (let i = 0; i < samples.length; i++) {
                            if (samples[i].type === 'key') { startIdx = i; break; }
                        }
                    }
                    if (clipOrdinal === 0 && recordingStartTime > 0) {
                        const startTimeUs = recordingStartTime * 1000000;
                        let lastKeyIdx = 0;
                        for (let i = 0; i < samples.length; i++) {
                            if (samples[i].type === 'key') lastKeyIdx = i;
                            if (samples[i].timestamp >= startTimeUs) { startIdx = lastKeyIdx; break; }
                        }
                    }

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
                    }
                    decoder.close();
                };

                try {
                    for (let clipOrdinal = 0; clipOrdinal < clips.length; clipOrdinal++) {
                        if (!isRecording) break;
                        await processClip(clips[clipOrdinal], clipOrdinal);
                    }
                    if (isRecording) {
                        currentClipContext = refClip;
                        cleanup();
                        await stopRecording();
                    }
                } catch (e) {
                    cleanup();
                    reject(e);
                }
                resolve();
            });
        } catch (e) {
            console.error("Synthesis error:", e);
            currentStatusKey = 'statusError'; currentStatusArg = e.message; currentStatusIsRec = false;
            updateStatus(t('statusError', e.message));
            isRecording = false;
            // 合成失败时 muxer/encoder 仍持有已编码的输出缓冲（可达数百 MB），
            // 必须显式释放，否则连续失败几次就会耗尽内存。
            muxer = null;
            if (encoder) {
                try { if (encoder.state !== 'closed') encoder.close(); } catch (_) { }
                encoder = null;
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
            startRecBtn.disabled = false;
            stopRecBtn.disabled = true;
            playPauseBtn.disabled = false;
            timeSlider.disabled = false;
        } finally {
            startRequestPending = false;
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
            // 立即切断 muxer 对完整输出 MP4（可达数百 MB）的引用，否则模块级变量会
            // 把它一直钉在堆上直到下次合成，连续导出极易 OOM。
            // 数据本身由 finalBlob → blob URL 独立持有，释放是安全的。
            muxer = null;
            const finalBlob = patchMp4Metadata(buffer, originalMediaDate, eventLocation);
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
        encoder = null;
        // 释放各片段解析器的顺序预读缓冲（每个最多 1MB）
        for (const c of clips) { if (c.parser) c.parser.releaseReadBuffer(); }
        startRecBtn.disabled = false; stopRecBtn.disabled = true;
        playPauseBtn.disabled = false; timeSlider.disabled = false;
    };

    // --- WebGL Render Loop ---
    const drawFrame = (forcedTime = null, sourceFrame = null) => {
        if (!hasWebGL) return;
        const source = sourceFrame || vid;
        if (!source || (!sourceFrame && source.readyState < 2)) return;

        const currentTime = forcedTime ?? vid.currentTime;
        const ctx = currentClipContext || { videoStartTime, parsedFrames, fps };
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
        reusableDate.setTime(ctx.videoStartTime + currentTime * 1000);
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

        if (ctx.parsedFrames && ctx.parsedFrames.length > 0) {
            const frameIndex = Math.min(Math.floor(currentTime * ctx.fps), ctx.parsedFrames.length - 1);
            const frame = ctx.parsedFrames[frameIndex];
            if (frame && frame.sei) {
                const sei = frame.sei;
                const speed = Math.round((sei.vehicleSpeedMps || 0) * 3.6);
                if (enumFields && enumFields.autopilotState) {
                    apState = enumFields.autopilotState.valuesById[sei.autopilotState] || "NONE";
                }
                isBrakeOn = !!sei.brakeApplied;
                accelNum = Math.round(sei.acceleratorPedalPosition || 0);
                speedVal = speed.toString();

                const rawGear = sei.gearState;
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

                isLeftBlinkerOn = !!sei.blinkerOnLeft;
                isRightBlinkerOn = !!sei.blinkerOnRight;
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
        // texImage2D 每帧都会重新分配纹理存储，代价很高；
        // 首次（或源尺寸变化时）分配一次，之后用 texSubImage2D 原地更新。
        const srcW = sourceFrame ? (sourceFrame.displayWidth || sourceFrame.codedWidth) : source.videoWidth;
        const srcH = sourceFrame ? (sourceFrame.displayHeight || sourceFrame.codedHeight) : source.videoHeight;
        if (!videoTextureInitialized || videoTexWidth !== srcW || videoTexHeight !== srcH) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            videoTextureInitialized = true;
            videoTexWidth = srcW;
            videoTexHeight = srcH;
        } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
        }

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
            const gt = mergedOffsets[previewClipIndex] + vid.currentTime;
            timeSlider.value = globalTimeToSlider(gt);
        }
        const gtDisplay = mergedOffsets[previewClipIndex] + vid.currentTime;
        timeDisplay.textContent = `${formatTime(gtDisplay)} / ${formatTime(mergedTotalDuration)}`;

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

    const setupPreview = async (clip, autoPlay = false) => {
        if (vid) {
            vid.pause();
            if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
        }
        currentParser = clip.parser;
        parsedFrames = clip.parsedFrames;
        videoStartTime = clip.videoStartTime;
        fps = clip.fps;
        firstKeyFrameTime = clip.firstKeyFrameTime;
        firstPlayLock = !autoPlay;
        vidName = clip.name;
        originalFileLastModified = clip.lastModified;
        enumFields = clip.enumFields;
        currentClipContext = clip;
        previewClipIndex = clips.indexOf(clip);

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

            let seekTarget = firstKeyFrameTime > 0.02 ? firstKeyFrameTime : 0;
            if (pendingSeekTime != null) seekTarget = Math.max(seekTarget, pendingSeekTime);
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
            pendingClipSwitch = null;
            const wasPendingSeek = pendingSeekTime != null;
            firstPlayTargetTime = wasPendingSeek ? pendingSeekTime
                : (firstKeyFrameTime > 0.02 ? firstKeyFrameTime : 0);
            pendingSeekTime = null;
            if (wxBridgeHandler) {
                document.removeEventListener('WeixinJSBridgeReady', wxBridgeHandler);
                wxBridgeHandler = null;
            }

            currentStatusKey = 'statusReady'; currentStatusArg = null; currentStatusIsRec = false;
            updateStatus(t('statusReady'));
            updateStartButtonState();
            // 跨段拖动定位(setupPreview(autoPlay=false) + pendingSeekTime)后停在该位置，不自动播放
            if (autoPlay && !wasPendingSeek) {
                syncPlayButton(false);
                playPending = true;
                if (animationId === null) animationId = requestAnimationFrame(render);
                nextVid.play().catch(() => { syncPlayButton(true); });
            }
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
        nextVid.onended = () => {
            syncPlayButton(true);
            animationId = null;
            if (isRecording) return;
            // 自动续播下一段，实现多视频连续预览
            if (clips.length > 1 && previewClipIndex >= 0 && previewClipIndex < clips.length - 1) {
                setupPreview(clips[previewClipIndex + 1], true);
            }
        };

        const handleStall = () => { if (!nextVid.paused && !isRecording) nextVid.currentTime += 0.005; };
        nextVid.onwaiting = handleStall;
        nextVid.onstalled = handleStall;

        if (currentVideoUrl) { try { URL.revokeObjectURL(currentVideoUrl); } catch (e) { } }
        currentVideoUrl = URL.createObjectURL(clip.file);
        nextVid.src = currentVideoUrl;
        vid = nextVid;
        nextVid.load();

        const tryActivate = (doLoad = false) => {
            if (isReady) return;
            try {
                if (doLoad) nextVid.load();
                // 自动续播模式：不在此主动 play，留给 onReady 在 seek 到起点后再播放，避免首帧黑屏
                if (autoPlay) return;
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
                        if (!autoPlay) nextVid.pause();
                    }).catch(() => {
                        if (nextVid.readyState >= 1 || nextVid.videoWidth) onReady();
                    });
                } else {
                    // Older browser: play() returns undefined, ensure video is paused
                    setTimeout(() => { if (!autoPlay) nextVid.pause(); }, 100);
                }
            } catch (e) { }
        };

        tryActivate();
        if (typeof WeixinJSBridge !== 'undefined') {
            WeixinJSBridge.invoke('getNetworkType', {}, () => tryActivate(true));
        }
        wxBridgeHandler = () => tryActivate(true);
        document.addEventListener('WeixinJSBridgeReady', wxBridgeHandler, { once: true });
    };

    const handleFiles = async (fileList) => {
        if (!fileList || fileList.length === 0) return;

        let jsonFile = null;
        const videoFiles = [];
        for (let i = 0; i < fileList.length; i++) {
            const f = fileList[i];
            const isVideo = f.type.startsWith('video/') || /\.(mp4|mov|m4v)$/i.test(f.name);
            const isJson = f.name.toLowerCase().endsWith('.json') || f.type === 'application/json';
            if (isVideo) videoFiles.push(f);
            else if (isJson && !jsonFile) jsonFile = f;
        }

        // event.json 坐标（合并后写入首段元数据）
        if (jsonFile) {
            try {
                const text = await jsonFile.text();
                const data = JSON.parse(text);
                const lat = data.est_lat !== undefined ? data.est_lat : data.latitude;
                const lon = data.est_lon !== undefined ? data.est_lon : data.longitude;
                if (lat !== undefined && lon !== undefined && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lon))) {
                    eventLocation = { lat: parseFloat(lat), lon: parseFloat(lon) };
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

        if (videoFiles.length === 0) return;

        syncPlayButton(true);
        fps = 36;
        cachedCanvasWidth = -1; cachedCanvasHeight = -1;
        textTextureInitialized = false;
        videoViewer.style.display = "block"; dropZone.style.display = "none";
        currentStatusKey = 'statusParsing'; currentStatusArg = null; currentStatusIsRec = false;
        updateStatus(t('statusParsing'));

        const parsed = [];
        for (const f of videoFiles) {
            try {
                const c = await MergeManager.prepareClip(f);
                if (c) parsed.push(c);
            } catch (e) {
                console.error("解析视频失败:", f.name, e);
            }
        }
        if (parsed.length === 0) {
            currentStatusKey = 'statusError'; currentStatusArg = '解析失败'; currentStatusIsRec = false;
            updateStatus(t('statusError', '没有可解析的视频'));
            return;
        }

        clips = MergeManager.sortClips(parsed);
        for (const c of clips) c.targetBitrate = computeTargetBitrate(c);
        mergeAnalysis = MergeManager.analyzeClips(clips);
        computeMergedTimeline();

        originalMediaDate = Math.floor(clips[0].videoStartTime / 1000) + MP4_EPOCH_OFFSET;
        vidName = clips[0].name + (clips.length > 1 ? '_merged' : '');
        targetBitrate = clips[0].targetBitrate;
        currentClipContext = clips[0];

        await setupPreview(clips[0]);
        fileInput.value = "";
        updateStartButtonState();
    };

    const updateStartButtonState = () => {
        if (!clips || clips.length === 0) { startRecBtn.disabled = true; return; }
        const capOk = checkCapabilities();
        const resOk = mergeAnalysis ? mergeAnalysis.resolutionOk : true;
        startRecBtn.disabled = !(capOk && resOk);
        // 只要能合成（段数不限），状态就保持为「已就绪」，不追加段数/时间连续性等附加信息。
        // 仅在无法合成时（分辨率不一致）才覆盖为错误提示——此时「开始合成」是禁用的，
        // 显示「已就绪」会自相矛盾。
        if (!resOk) {
            statusText.textContent = '分辨率不一致：请仅导入同一摄像头视角的视频';
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
        // 统一的全局时间定位：live=true 表示拖动过程中（oninput），false 表示松手（onchange）
        // 跨片段拖动时「立即」切换视频源并在目标位置定位，使预览在拖动过程中实时跟随进度条，
        // 而不是停在旧片段的末帧/首帧直到松手。
        const applyGlobalScrub = (live) => {
            const gt = sliderToGlobalTime(timeSlider.value);
            timeDisplay.textContent = `${formatTime(gt)} / ${formatTime(mergedTotalDuration)}`;
            const { i, localTime } = findClipForGlobalTime(gt);
            const targetClip = clips[i] || null;
            const fkf = targetClip ? targetClip.firstKeyFrameTime : 0;
            // 首帧非关键帧：落点在首个关键帧之前时对齐到关键帧，避免预览黑屏与解码卡顿
            const clamped = (fkf > 0.02 && localTime < fkf) ? fkf : localTime;

            if (i === previewClipIndex) {
                // 本段内：实时拖动预览
                pendingClipSwitch = null;
                scrubTarget = clamped;
                if (live && !scrubRaf) {
                    lastScrubTime = 0;
                    scrubRaf = requestAnimationFrame(scrubLoop);
                }
            } else {
                // 跨片段：立即切换视频源并在目标位置定位，使画面随拖动实时更新
                pendingSeekTime = clamped;
                if (pendingClipSwitch !== i) {
                    pendingClipSwitch = i;
                    if (vid) vid.pause();
                    setupPreview(clips[i], false);
                }
                scrubTarget = null;
            }
        };

        timeSlider.oninput = () => {
            dragging = true;
            applyGlobalScrub(true);
        };

        timeSlider.onchange = () => {
            if (scrubRaf) { cancelAnimationFrame(scrubRaf); scrubRaf = null; }
            const gt = sliderToGlobalTime(timeSlider.value);
            const { i, localTime } = findClipForGlobalTime(gt);
            dragging = false;
            firstPlayLock = false;
            if (i === previewClipIndex) {
                scrubTarget = null;
                let target = localTime;
                const fkf = clips[i] ? clips[i].firstKeyFrameTime : 0;
                if (fkf > 0.02 && target < fkf) target = fkf;
                vid.currentTime = target;
                if (target !== localTime) {
                    const ng = mergedOffsets[i] + target;
                    timeSlider.value = globalTimeToSlider(ng);
                    timeDisplay.textContent = `${formatTime(ng)} / ${formatTime(mergedTotalDuration)}`;
                }
                render();
            } else {
                // 兜底：极少数情况（如某些浏览器点击未触发 oninput）下跨段跳转
                pendingSeekTime = (clips[i] && clips[i].firstKeyFrameTime > 0.02 && localTime < clips[i].firstKeyFrameTime)
                    ? clips[i].firstKeyFrameTime : localTime;
                if (pendingClipSwitch !== i) {
                    pendingClipSwitch = i;
                    setupPreview(clips[i], false);
                }
            }
        };
    }

    window.onload = () => {
        if (!checkCapabilities()) {
            currentStatusKey = 'statusNoSupport'; currentStatusArg = null; currentStatusIsRec = false;
            updateStatus(t('statusNoSupport'));
        }
    };
})();
