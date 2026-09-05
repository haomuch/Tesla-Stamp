/**
 * Tesla Dashcam MP4 Parser & Protobuf Initializer
 * Parses MP4 files and extracts SEI metadata from Tesla dashcam footage.
 */

const MP4_EPOCH_OFFSET = 2082844800;

// 样本数据顺序预读块大小：解析与合成都是严格顺序访问，
// 一次读取 1MB 可把「每帧一次文件 I/O」降为「每 1MB 一次」。
const READ_CHUNK = 1 << 20;

// 主线程让出工具：扫描整个视频的 SEI 是一次长时间同步循环，
// 必须周期性让出主线程，否则 UI 会完全冻结（连状态提示都来不及渲染）。
const _yieldQueue = [];
const _yieldChannel = (typeof MessageChannel !== 'undefined') ? new MessageChannel() : null;
if (_yieldChannel) {
    _yieldChannel.port1.onmessage = () => {
        const r = _yieldQueue.shift();
        if (r) r();
    };
}
const yieldToUi = () => {
    if (!_yieldChannel) return new Promise(r => setTimeout(r, 0));
    return new Promise(r => { _yieldQueue.push(r); _yieldChannel.port2.postMessage(null); });
};
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class DashcamMP4 {
    /**
     * @param {Uint8Array|File|Blob|ArrayBuffer} source - Source video buffer or file handle.
     */
    constructor(source) {
        if (source instanceof Uint8Array) {
            this.buffer = source;
        } else if (source instanceof ArrayBuffer) {
            this.buffer = new Uint8Array(source);
        } else {
            this.buffer = null;
            this.sourceFile = source;
        }

        // this.view 始终指向「box 解析视图」：
        //   全量模式 = 整个文件；文件模式 = 仅 moov（由 init() 懒加载）
        // this._boxData 是 view 对应的 Uint8Array，用于切片拷贝。
        if (this.buffer) {
            this.view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
            this._boxData = this.buffer;
        } else {
            this.view = null;
            this._boxData = null;
        }

        this._config = null;
        this._samples = null;
        this.isHEVC = false;
        this._reusableSeiBuf = new Uint8Array(65536);

        // 顺序预读缓冲（仅文件模式使用）
        this._readBuf = null;
        this._readStart = 0;
        this._readEnd = 0;
    }

    attachSource(source) {
        if (source instanceof File || source instanceof Blob) {
            this.sourceFile = source;
        }
    }

    /**
     * 文件模式初始化：只把 moov 读进内存（通常几十 KB ~ 数 MB），
     * 样本数据留在磁盘上按需读取，避免整个视频常驻内存导致移动端 OOM。
     * 全量模式（构造时传入 ArrayBuffer/Uint8Array）无需调用。
     */
    async init() {
        if (this.view) return;
        if (!this.sourceFile) throw new Error("缺少视频数据源");

        const { start, end } = await this._locateMoov();
        const buf = await this.sourceFile.slice(start, end).arrayBuffer();
        this._boxData = new Uint8Array(buf);
        this.view = new DataView(this._boxData.buffer);
    }

    /**
     * 分块扫描顶层 box 链定位 moov。顶层 box 数量极少（ftyp/moov/free/mdat…），
     * 因此只需读取文件头尾各一小块即可完成定位，无需加载整个文件。
     */
    async _locateMoov() {
        const fileSize = this.sourceFile.size;
        const CHUNK = 1 << 20;
        let pos = 0;
        let chunkStart = 0;
        let chunk = null;
        let chunkView = null;

        while (pos + 8 <= fileSize) {
            // 保证当前窗口内至少能读到一个完整的 box 头（含 64 位 largesize）
            if (!chunk || pos < chunkStart || pos + 16 > chunkStart + chunk.byteLength) {
                chunkStart = pos;
                const end = Math.min(fileSize, pos + CHUNK);
                chunk = new Uint8Array(await this.sourceFile.slice(pos, end).arrayBuffer());
                chunkView = new DataView(chunk.buffer);
            }

            const rel = pos - chunkStart;
            if (rel + 8 > chunk.byteLength) break;

            let size = chunkView.getUint32(rel);
            const type = this._ascii(chunk, rel + 4, 4);
            let headerSize = 8;

            if (size === 1) {
                if (rel + 16 > chunk.byteLength) break;
                const high = chunkView.getUint32(rel + 8);
                const low = chunkView.getUint32(rel + 12);
                size = Number((BigInt(high) << 32n) | BigInt(low));
                headerSize = 16;
            } else if (size === 0) {
                size = fileSize - pos;
            }

            if (!Number.isFinite(size) || size < headerSize || pos + size > fileSize) break;

            if (type === 'moov') return { start: pos + headerSize, end: pos + size };
            pos += size;
        }
        throw new Error("未能在文件中定位 moov（文件可能已损坏或不是 MP4/MOV）");
    }

    _ascii(buf, start, len) {
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(buf[start + i]);
        return s;
    }

    async readSampleData(offset, size) {
        if (this.buffer) {
            return this.buffer.subarray(offset, offset + size);
        }

        if (!this.sourceFile) {
            return null;
        }

        // 顺序预读缓冲：解析与合成都是严格递增访问，命中率接近 100%。
        // 原先的 LRU 缓存在顺序场景下命中率为 0，却会常驻若干最大样本，纯属浪费。
        if (this._readBuf && offset >= this._readStart && offset + size <= this._readEnd) {
            const rel = offset - this._readStart;
            return this._readBuf.subarray(rel, rel + size);
        }

        try {
            // 文件被截断时不要返回残缺样本，否则会构造出无法解码的 EncodedVideoChunk
            if (offset + size > this.sourceFile.size) {
                console.warn('样本数据超出文件范围，已跳过');
                return null;
            }
            const want = Math.max(READ_CHUNK, size);
            const end = Math.min(this.sourceFile.size, offset + want);
            const slice = await this.sourceFile.slice(offset, end).arrayBuffer();
            this._readBuf = new Uint8Array(slice);
            this._readStart = offset;
            this._readEnd = end;
            return this._readBuf.subarray(0, size);
        } catch (error) {
            console.warn('Sample read failed:', error);
            return null;
        }
    }

    /** 释放顺序预读缓冲（合成结束后调用，避免残留 1MB 常驻） */
    releaseReadBuffer() {
        this._readBuf = null;
        this._readStart = 0;
        this._readEnd = 0;
    }

    findBox(start, end, name) {
        for (let pos = start; pos + 8 <= end;) {
            let size = this.view.getUint32(pos);
            const type = this.readAscii(pos + 4, 4);
            let headerSize = 8;

            if (size === 1) {
                // largesize 需要额外 8 字节，越界则视为损坏，直接终止遍历
                if (pos + 16 > end) break;
                const high = this.view.getUint32(pos + 8);
                const low = this.view.getUint32(pos + 12);
                size = Number((BigInt(high) << 32n) | BigInt(low));
                headerSize = 16;
            } else if (size === 0) {
                size = end - pos;
            }

            // 损坏/截断文件可能解析出非法长度（小于头部或越界）。
            // 若不拦截，pos 不前进会导致死循环并永久冻结主线程。
            if (!Number.isFinite(size) || size < headerSize || pos + size > end) break;

            if (type === name) {
                return { start: pos + headerSize, end: pos + size, size: size - headerSize };
            }
            pos += size;
        }
        throw new Error(`Box "${name}" not found`);
    }

    findMdat() {
        const mdat = this.findBox(0, this.view.byteLength, 'mdat');
        return { offset: mdat.start, size: mdat.size };
    }

    getConfig() {
        if (this._config) return this._config;
        if (!this.view) throw new Error("解析器尚未初始化，请先调用 init()");

        // 文件模式下 this.view 就是 moov 本身；全量模式需要从文件顶层定位 moov
        const moov = this.buffer
            ? this.findBox(0, this.view.byteLength, 'moov')
            : { start: 0, end: this.view.byteLength, size: this.view.byteLength };
        let trakPos = moov.start;

        while (trakPos < moov.end) {
            let trak;
            try {
                trak = this.findBox(trakPos, moov.end, 'trak');
            } catch (e) { break; }

            try {
                const mdia = this.findBox(trak.start, trak.end, 'mdia');
                const minf = this.findBox(mdia.start, mdia.end, 'minf');
                const stbl = this.findBox(minf.start, minf.end, 'stbl');
                const stsd = this.findBox(stbl.start, stbl.end, 'stsd');

                let videoBoxEntry = null, descriptionBoxName = "", type = "avc";
                for (const format of [
                    { name: 'avc1', desc: 'avcC', type: 'avc' },
                    { name: 'hvc1', desc: 'hvcC', type: 'hevc' },
                    { name: 'hev1', desc: 'hvcC', type: 'hevc' }
                ]) {
                    try {
                        videoBoxEntry = this.findBox(stsd.start + 8, stsd.end, format.name);
                        descriptionBoxName = format.desc;
                        type = format.type;
                        break;
                    } catch (e) { }
                }

                if (videoBoxEntry) {
                    this.isHEVC = (type === 'hevc');
                    const descriptionBox = this.findBox(videoBoxEntry.start + 78, videoBoxEntry.end, descriptionBoxName);
                    let codec = "";
                    if (type === 'avc') {
                        const o = descriptionBox.start;
                        codec = `avc1.${this.hex(this.view.getUint8(o + 1))}${this.hex(this.view.getUint8(o + 2))}${this.hex(this.view.getUint8(o + 3))}`;
                    } else {
                        codec = 'hvc1.1.6.L120.B0';
                    }

                    const mdhd = this.findBox(mdia.start, mdia.end, 'mdhd');
                    const mdhdVersion = this.view.getUint8(mdhd.start);
                    const timescale = mdhdVersion === 1
                        ? this.view.getUint32(mdhd.start + 20)
                        : this.view.getUint32(mdhd.start + 12);

                    const stts = this.findBox(stbl.start, stbl.end, 'stts');
                    const entryCount = this.view.getUint32(stts.start + 4);
                    const durations = [];
                    let pos = stts.start + 8;
                    for (let i = 0; i < entryCount; i++) {
                        const count = this.view.getUint32(pos);
                        const delta = this.view.getUint32(pos + 4);
                        const ms = (delta / timescale) * 1000;
                        for (let j = 0; j < count; j++) durations.push(ms);
                        pos += 8;
                    }

                    this._config = {
                        width: this.view.getUint16(videoBoxEntry.start + 24),
                        height: this.view.getUint16(videoBoxEntry.start + 26),
                        codec, timescale, durations,
                        description: new Uint8Array(this._boxData.subarray(descriptionBox.start, descriptionBox.start + descriptionBox.size)),
                        type, _stbl: stbl
                    };
                    return this._config;
                }
            } catch (e) {
                // Non-video track, try next trak
            }
            trakPos = trak.end;
        }
        throw new Error("不支持的视频格式（未在任何轨道中找到有效视频流）");
    }

    getSamples() {
        if (this._samples) return this._samples;

        const config = this.getConfig();
        const stbl = config._stbl;

        const stsz = this.findBox(stbl.start, stbl.end, 'stsz');
        const sampleSizeDefault = this.view.getUint32(stsz.start + 4);
        const sampleCount = this.view.getUint32(stsz.start + 8);
        const sampleSizes = [];
        if (sampleSizeDefault === 0) {
            for (let i = 0; i < sampleCount; i++) sampleSizes.push(this.view.getUint32(stsz.start + 12 + i * 4));
        } else {
            for (let i = 0; i < sampleCount; i++) sampleSizes.push(sampleSizeDefault);
        }

        let chunkOffsets = [];
        try {
            const stco = this.findBox(stbl.start, stbl.end, 'stco');
            const entryCount = this.view.getUint32(stco.start + 4);
            for (let i = 0; i < entryCount; i++) chunkOffsets.push(this.view.getUint32(stco.start + 8 + i * 4));
        } catch {
            const co64 = this.findBox(stbl.start, stbl.end, 'co64');
            const entryCount = this.view.getUint32(co64.start + 4);
            for (let i = 0; i < entryCount; i++) chunkOffsets.push(Number(this.view.getBigUint64(co64.start + 8 + i * 8)));
        }

        let ptsOffsets = null;
        try {
            const ctts = this.findBox(stbl.start, stbl.end, 'ctts');
            const entryCount = this.view.getUint32(ctts.start + 4);
            ptsOffsets = new Int32Array(sampleCount);
            let pos = ctts.start + 8;
            let idx = 0;
            for (let i = 0; i < entryCount; i++) {
                const count = this.view.getUint32(pos);
                const offset = this.view.getInt32(pos + 4);
                for (let j = 0; j < count && idx < sampleCount; j++) ptsOffsets[idx++] = offset;
                pos += 8;
            }
        } catch (e) { }

        const stsc = this.findBox(stbl.start, stbl.end, 'stsc');
        const stscEntries = this.view.getUint32(stsc.start + 4);
        const sampleToChunk = [];
        for (let i = 0; i < stscEntries; i++) {
            sampleToChunk.push({
                firstChunk: this.view.getUint32(stsc.start + 8 + i * 12),
                samplesPerChunk: this.view.getUint32(stsc.start + 12 + i * 12)
            });
        }

        const keyframes = new Set();
        try {
            const stss = this.findBox(stbl.start, stbl.end, 'stss');
            const entryCount = this.view.getUint32(stss.start + 4);
            for (let i = 0; i < entryCount; i++) keyframes.add(this.view.getUint32(stss.start + 8 + i * 4) - 1);
        } catch {
            keyframes.add(0);
        }

        const samples = [];
        let currentSample = 0;
        let currentTimeUs = 0;
        let stscCursor = 0;

        // 共享的 loadData：长视频有数万个样本，若每个样本各自持有一个闭包，
        // 会额外产生数万个函数对象。通过 this 绑定复用同一个函数。
        const self = this;
        const loadSampleData = function () {
            return self.readSampleData(this.offset, this.size);
        };
        let currentSamplesPerChunk = sampleToChunk.length > 0 ? sampleToChunk[0].samplesPerChunk : 1;

        for (let i = 0; i < chunkOffsets.length; i++) {
            const chunkIdx = i + 1;
            while (stscCursor + 1 < sampleToChunk.length && chunkIdx >= sampleToChunk[stscCursor + 1].firstChunk) {
                stscCursor++;
                currentSamplesPerChunk = sampleToChunk[stscCursor].samplesPerChunk;
            }
            let offset = chunkOffsets[i];

            for (let j = 0; j < currentSamplesPerChunk; j++) {
                if (currentSample >= sampleCount) break;
                const size = sampleSizes[currentSample];
                const durationMs = config.durations[currentSample] || (1000 / 36);
                const ptsOffsetUs = ptsOffsets ? (ptsOffsets[currentSample] / config.timescale) * 1000000 : 0;
                const sampleObj = {
                    offset,
                    size,
                    timestamp: Math.round(currentTimeUs + ptsOffsetUs),
                    duration: Math.round(durationMs * 1000),
                    type: keyframes.has(currentSample) ? 'key' : 'delta'
                };
                sampleObj.loadData = loadSampleData;
                samples.push(sampleObj);

                offset += size;
                currentTimeUs += durationMs * 1000;
                currentSample++;
            }
        }
        this._samples = samples;
        return this._samples;
    }

    getCreationTime() {
        try {
            if (!this.view) return null;
            const moov = this.buffer
                ? this.findBox(0, this.view.byteLength, 'moov')
                : { start: 0, end: this.view.byteLength };
            const mvhd = this.findBox(moov.start, moov.end, 'mvhd');
            const version = this.view.getUint8(mvhd.start);
            const secondsSince1904 = version === 1
                ? Number(this.view.getBigUint64(mvhd.start + 4))
                : this.view.getUint32(mvhd.start + 4);

            if (secondsSince1904 === 0) return null;
            return (secondsSince1904 - MP4_EPOCH_OFFSET) * 1000;
        } catch (e) {
            return null;
        }
    }

    async parseFrames(SeiMetadata) {
        const frames = [];
        let pendingSei = null;
        let lastYield = nowMs();

        const samples = this.getSamples();
        for (let idx = 0; idx < samples.length; idx++) {
            const s = samples[idx];
            const sampleBuf = this.buffer
                ? this.buffer.subarray(s.offset, s.offset + s.size)
                : await this.readSampleData(s.offset, s.size);
            if (!sampleBuf || sampleBuf.byteLength < 4) continue;

            const dv = new DataView(sampleBuf.buffer, sampleBuf.byteOffset, sampleBuf.byteLength);
            let cursor = 0;
            const end = sampleBuf.byteLength;
            while (cursor + 4 <= end) {
                const len = dv.getUint32(cursor);
                cursor += 4;
                if (len < 1 || cursor + len > end) break;

                const nalHeaderByte0 = sampleBuf[cursor];
                const type = this.isHEVC ? ((nalHeaderByte0 >> 1) & 0x3F) : (nalHeaderByte0 & 0x1F);

                if ((!this.isHEVC && type === 6) || (this.isHEVC && type === 39)) {
                    const headerLen = this.isHEVC ? 2 : 1;
                    const seiData = new Uint8Array(sampleBuf.subarray(cursor + headerLen, cursor + len));
                    pendingSei = this.decodeSei(seiData, SeiMetadata);
                } else if ((!this.isHEVC && type >= 1 && type <= 5) || (this.isHEVC && type <= 31)) {
                    frames.push({ sei: pendingSei });
                    pendingSei = null;
                }
                cursor += len;
            }

            // 每累积约 8ms 的同步扫描就让出一次主线程。这段循环要读完整个码流，
            // 若不让出，UI 会长时间完全冻结，连"正在解析"提示都来不及渲染。
            if ((idx & 15) === 15 && nowMs() - lastYield > 8) {
                await yieldToUi();
                lastYield = nowMs();
            }
        }
        return frames;
    }

    decodeSei(nal, SeiMetadata) {
        if (!SeiMetadata || nal.length < 4) return null;

        let i = 3;
        while (i < nal.length && nal[i] === 0x42) i++;
        if (i <= 3 || i + 1 >= nal.length || nal[i] !== 0x69) return null;

        try {
            const d = SeiMetadata.decode(this.stripEmulationBytes(nal.subarray(i + 1, nal.length - 1)));
            if (!d) return null;

            // 只保留绘制真正需要的字段。protobuf 的 Message 实例带有原型链和全部 16 个字段，
            // 每个视频帧都保留一份会显著放大内存（数万帧 × 完整对象）。
            // 同时把命名统一为驼峰，省去下游的兼容分支。
            const rawGear = d.gearState !== undefined ? d.gearState : d.gear_state;
            return {
                // frameSeqNo 不是绘制字段，但 MergeManager 用它推导视频起始时间基准，必须保留
                frameSeqNo: d.frameSeqNo,
                vehicleSpeedMps: d.vehicleSpeedMps || 0,
                autopilotState: d.autopilotState || 0,
                brakeApplied: !!d.brakeApplied,
                acceleratorPedalPosition: d.acceleratorPedalPosition || 0,
                gearState: rawGear !== undefined ? rawGear : 0,
                blinkerOnLeft: !!(d.blinkerOnLeft || d.blinker_on_left),
                blinkerOnRight: !!(d.blinkerOnRight || d.blinker_on_right)
            };
        } catch {
            return null;
        }
    }

    stripEmulationBytes(data) {
        if (!this._reusableSeiBuf || this._reusableSeiBuf.length < data.length) {
            this._reusableSeiBuf = new Uint8Array(Math.max(65536, data.length * 2));
        }
        const out = this._reusableSeiBuf;
        let zeros = 0;
        let w = 0;
        for (let i = 0; i < data.length; i++) {
            const byte = data[i];
            if (zeros >= 2 && byte === 0x03) { zeros = 0; continue; }
            out[w++] = byte;
            zeros = byte === 0 ? zeros + 1 : 0;
        }
        return out.subarray(0, w);
    }

    readAscii(start, len) {
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(this.view.getUint8(start + i));
        return s;
    }

    hex(n) { return n.toString(16).padStart(2, '0'); }
}

window.DashcamMP4 = DashcamMP4;

(function () {
    let SeiMetadata = null;
    let cachedEnumFields = null;

    async function initProtobuf() {
        if (SeiMetadata) return { SeiMetadata, enumFields: cachedEnumFields };

        const protoText = `
        syntax = "proto3";
        message SeiMetadata {
        uint32 version = 1;
        enum Gear { PARK = 0; DRIVE = 1; REVERSE = 2; NEUTRAL = 3; }
        Gear gear_state = 2;
        uint64 frame_seq_no = 3;
        float vehicle_speed_mps = 4;
        float accelerator_pedal_position = 5;
        float steering_wheel_angle = 6;
        bool blinker_on_left = 7;
        bool blinker_on_right = 8;
        bool brake_applied = 9;
        enum AutopilotState { NONE = 0; TACC = 1; AUTO = 2; FULL = 3; }
        AutopilotState autopilot_state = 10;
        double latitude_deg = 11;
        double longitude_deg = 12;
        double heading_deg = 13;
        double linear_acceleration_mps2_x = 14;
        double linear_acceleration_mps2_y = 15;
        double linear_acceleration_mps2_z = 16;
        }`;

        const root = protobuf.parse(protoText).root;
        SeiMetadata = root.lookupType('SeiMetadata');
        cachedEnumFields = {
            gearState: SeiMetadata.lookup('Gear'),
            autopilotState: SeiMetadata.lookup('AutopilotState')
        };
        return { SeiMetadata, enumFields: cachedEnumFields };
    }

    window.DashcamHelpers = { initProtobuf };
})();
