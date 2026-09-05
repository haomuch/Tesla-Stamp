/**
 * Tesla Dashcam Stamp - Merge Manager
 * 纯逻辑模块：多视频片段的解析、排序、时间戳连续性校验、分辨率一致性校验。
 * 不触碰任何 UI / WebGL / WebCodecs，便于在 app.js 中复用。
 *
 * 依赖全局：DashcamMP4、DashcamHelpers（已在 index.html 中先于本文件加载）。
 * 通过 window.MergeManager 暴露。
 */
(function () {
    'use strict';

    let _protobuf = null;

    const getProtobuf = async () => {
        if (!_protobuf) {
            _protobuf = await DashcamHelpers.initProtobuf();
        }
        return _protobuf;
    };

    const getCameraFromName = (name) => {
        const m = name.match(/_(front|back|left_repeater|right_repeater|left|right)(?:[_\-.]|$)/i)
            || name.match(/(front|back|left|right)/i);
        if (!m) return '';
        const c = m[1].toLowerCase();
        if (c.indexOf('front') >= 0) return 'FRONT';
        if (c.indexOf('back') >= 0) return 'BACK';
        if (c.indexOf('left') >= 0) return 'LEFT';
        if (c.indexOf('right') >= 0) return 'RIGHT';
        return c.toUpperCase();
    };

    /**
     * 解析单个视频文件，返回 Clip 上下文对象（不含 UI 状态）。
     * 解析失败返回 null。
     */
    const prepareClip = async (file) => {
        const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v)$/i.test(file.name);
        if (!isVideo) return null;

        const protobuf = await getProtobuf();
        const enumFields = protobuf.enumFields;
        // 文件模式：不把整个视频读进内存，只加载 moov，样本数据在解析/合成时按需读取。
        // 整包 arrayBuffer() 在多段导入时会直接撑爆移动端内存上限。
        const parser = new DashcamMP4(file);
        await parser.init();
        const parsedFrames = await parser.parseFrames(protobuf.SeiMetadata);
        const config = parser.getConfig();
        const samples = parser.getSamples();

        let firstKeyFrameTime = 0;
        for (const s of samples) {
            if (s.type === 'key') {
                firstKeyFrameTime = s.timestamp / 1000000;
                break;
            }
        }

        let fps = 36;
        let durationMs = 0;
        if (config.durations && config.durations.length > 0) {
            durationMs = config.durations.reduce((a, b) => a + b, 0);
            if (durationMs > 0) fps = Math.round(config.durations.length / (durationMs / 1000));
        } else {
            for (const s of samples) durationMs += s.duration / 1000;
        }

        const totalVideoBytes = samples.reduce((sum, s) => sum + s.size, 0);
        const durationSec = durationMs / 1000;
        const originalBitrate = durationSec > 0
            ? Math.round((totalVideoBytes * 8) / durationSec)
            : 6000000;

        const dateMatch = file.name.match(/(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/);
        const firstSei = parsedFrames.find(f => f.sei)?.sei;
        const mp4CreationTime = parser.getCreationTime();

        let videoStartTime = 0;
        let timeBaseSource = 'fallback';
        if (firstSei && firstSei.frameSeqNo) {
            const seq = Number(firstSei.frameSeqNo);
            if (seq > 1000000000000) {
                videoStartTime = seq;
                timeBaseSource = 'SEI 毫秒级时间戳';
            } else if (seq > 1000000000) {
                videoStartTime = seq * 1000;
                timeBaseSource = 'SEI 秒级时间戳';
            }
        }
        if (!videoStartTime && dateMatch) {
            videoStartTime = new Date(
                `${dateMatch[1].replace(/-/g, '/')} ${dateMatch[2].replace(/-/g, ':')}`
            ).getTime();
            timeBaseSource = '文件名日期';
        }
        if (!videoStartTime) {
            if (mp4CreationTime) {
                videoStartTime = mp4CreationTime;
                timeBaseSource = 'MP4 头部创建时间';
            } else {
                videoStartTime = file.lastModified || Date.now();
                timeBaseSource = file.lastModified ? '文件最后修改时间' : '当前系统时间';
            }
        }

        const creationTime = mp4CreationTime || videoStartTime;

        return {
            file,
            parser,
            config,
            samples,
            parsedFrames,
            enumFields,
            name: file.name.substring(0, file.name.lastIndexOf('.')),
            fullName: file.name,
            lastModified: file.lastModified,
            width: config.width,
            height: config.height,
            codec: config.codec,
            fps,
            durationMs,
            firstKeyFrameTime,
            videoStartTime,
            creationTime,
            timeBaseSource,
            originalBitrate,
            camera: getCameraFromName(file.name)
        };
    };

    /**
     * 按时间基准升序排序（仅返回新数组，不修改入参）。
     */
    const sortClips = (clips) => {
        return clips.slice().sort((a, b) => a.videoStartTime - b.videoStartTime);
    };

    /**
     * 校验分辨率一致性 + 计算相邻片段时间连续性。
     * @returns {{ resolutionOk:boolean, mismatch:Set<string>, continuity:Array<{gapMs:number,status:string}> }}
     *   status: 'start' | 'continuous' | 'gap' | 'overlap'
     */
    const analyzeClips = (clips, toleranceMs = 1000) => {
        const mismatch = new Set();
        if (clips.length > 0) {
            const ref = clips[0];
            for (const c of clips) {
                if (c.width !== ref.width || c.height !== ref.height) {
                    mismatch.add(c.fullName);
                }
            }
        }
        const continuity = [];
        for (let i = 0; i < clips.length; i++) {
            if (i === 0) {
                continuity.push({ gapMs: 0, status: 'start' });
                continue;
            }
            const prevEnd = clips[i - 1].videoStartTime + clips[i - 1].durationMs;
            const gapMs = clips[i].videoStartTime - prevEnd;
            let status = 'continuous';
            if (gapMs > toleranceMs) status = 'gap';
            else if (gapMs < -toleranceMs) status = 'overlap';
            continuity.push({ gapMs, status });
        }
        return { resolutionOk: mismatch.size === 0, mismatch, continuity };
    };

    window.MergeManager = {
        prepareClip,
        sortClips,
        analyzeClips,
        getProtobuf
    };
})();
