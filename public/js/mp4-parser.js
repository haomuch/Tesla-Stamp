/**
 * Tesla Dashcam MP4 Parser & Protobuf Initializer
 * Parses MP4 files and extracts SEI metadata from Tesla dashcam footage.
 */

const MP4_EPOCH_OFFSET = 2082844800;

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

        if (this.buffer) {
            this.view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
        } else {
            this.view = null;
        }

        this._config = null;
        this._samples = null;
        this.isHEVC = false;
        this._reusableSeiBuf = new Uint8Array(65536);
        this._sampleDataCache = new Map();
    }

    attachSource(source) {
        if (source instanceof File || source instanceof Blob) {
            this.sourceFile = source;
        }
    }

    async readSampleData(offset, size) {
        if (this.buffer) {
            return this.buffer.subarray(offset, offset + size);
        }

        if (!this.sourceFile) {
            return null;
        }

        const key = `${offset}:${size}`;
        if (this._sampleDataCache.has(key)) {
            return this._sampleDataCache.get(key);
        }

        try {
            const slice = await this.sourceFile.slice(offset, offset + size).arrayBuffer();
            const data = new Uint8Array(slice);
            this._sampleDataCache.set(key, data);
            if (this._sampleDataCache.size > 16) {
                const firstKey = this._sampleDataCache.keys().next().value;
                this._sampleDataCache.delete(firstKey);
            }
            return data;
        } catch (error) {
            console.warn('Sample read failed:', error);
            return null;
        }
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

        const moov = this.findBox(0, this.view.byteLength, 'moov');
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
                        description: new Uint8Array(this.buffer.subarray(descriptionBox.start, descriptionBox.start + descriptionBox.size)),
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
                sampleObj.loadData = async () => this.readSampleData(sampleObj.offset, sampleObj.size);
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
            const moov = this.findBox(0, this.view.byteLength, 'moov');
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

        const samples = this.getSamples();
        for (const s of samples) {
            const sampleBuf = this.buffer
                ? this.buffer.subarray(s.offset, s.offset + s.size)
                : await this.readSampleData(s.offset, s.size);

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
        }
        return frames;
    }

    decodeSei(nal, SeiMetadata) {
        if (!SeiMetadata || nal.length < 4) return null;

        let i = 3;
        while (i < nal.length && nal[i] === 0x42) i++;
        if (i <= 3 || i + 1 >= nal.length || nal[i] !== 0x69) return null;

        try {
            return SeiMetadata.decode(this.stripEmulationBytes(nal.subarray(i + 1, nal.length - 1)));
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
