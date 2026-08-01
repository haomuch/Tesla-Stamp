/**
 * Tesla Dashcam Stamp - i18n & Status Manager
 */

const i18n = {
    zh: {
        subtitle: '特斯拉行车记录仪水印工具',
        guideTitle: '使用说明',
        guideStep1: '导入原始视频文件，自动基于元数据添加水印',
        guideStep2: '手机浏览器合成过程中，请勿切换到其他界面',
        guideStep3: '所有文件都在客户端处理，不会上传到服务器',
        uploadPrompt: '选择原始视频文件',
        statusWaiting: '等待导入视频...',
        statusParsing: '正在解析遥测数据...',
        statusLoading: '正在加载视频...',
        statusReady: '已就绪',
        statusPreparing: '正在准备...',
        statusSynthesizing: '正在合成...',
        statusSynthesizingProgress: (t) => `正在合成: ${t}s`,
        statusExporting: '正在导出...',
        statusDone: '处理完成',
        statusError: (msg) => `合成出错: ${msg}`,
        statusNoSupport: '当前浏览器不支持合成功能',
        reselectBtn: '更换视频',
        startRecBtn: '开始合成',
        stopRecBtn: '保存视频',
        webglAlert: '您的浏览器不支持 WebGL 2.0，无法运行此渲染管线。',
        shaderAlert: 'WebGL 着色器链接失败，请尝试更新浏览器。\n\n',
    },
    en: {
        subtitle: 'Tesla Dashcam Watermark Tool',
        guideTitle: 'How to Use',
        guideStep1: 'Import raw video files to add SEI data.',
        guideStep2: 'Do not switch apps/tabs while recording.',
        guideStep3: 'All files are processed only on your device.',
        uploadPrompt: 'Select Video File',
        statusWaiting: 'Waiting for video...',
        statusParsing: 'Parsing telemetry data...',
        statusLoading: 'Loading video...',
        statusReady: 'Ready',
        statusPreparing: 'Preparing...',
        statusSynthesizing: 'Recording...',
        statusSynthesizingProgress: (t) => `Recording: ${t}s`,
        statusExporting: 'Exporting...',
        statusDone: 'Done',
        statusError: (msg) => `Recording error: ${msg}`,
        statusNoSupport: 'This browser does not support recording',
        reselectBtn: 'Change Video',
        startRecBtn: 'Start Recording',
        stopRecBtn: 'Stop & Save',
        webglAlert: 'Your browser does not support WebGL 2.0. This rendering pipeline cannot run.',
        shaderAlert: 'WebGL shader link failed. Please try updating your browser.\n\n',
    }
};

let currentLang = localStorage.getItem('tesla_dashcam_lang') || 'zh';

let currentStatusKey = 'statusWaiting';
let currentStatusArg = null;
let currentStatusIsRec = false;

const t = (key, arg) => {
    const val = i18n[currentLang][key];
    if (typeof val === 'function') return val(arg);
    return val || key;
};

const updateStatus = (text, isRec = false) => {
    const statusText = document.querySelector("#statusText");
    const statusBadge = document.querySelector("#statusBadge");
    const reselectBtn = document.querySelector("#reselectBtn");
    
    if (statusText) statusText.textContent = text;
    if (statusBadge) {
        isRec ? statusBadge.classList.add("recording") : statusBadge.classList.remove("recording");
    }
    const reselectKeys = ['statusReady', 'statusDone', 'statusNoSupport'];
    const showReselect = reselectKeys.includes(currentStatusKey);
    if (reselectBtn) {
        reselectBtn.style.display = showReselect ? "inline-flex" : "none";
    }
};

const updateLangIndicator = (skipTransition = false) => {
    const indicator = document.getElementById('langIndicator');
    const activeBtn = currentLang === 'zh'
        ? document.getElementById('langOptZh')
        : document.getElementById('langOptEn');
    if (!indicator || !activeBtn) return;
    const tx = activeBtn.offsetLeft;

    if (skipTransition) {
        const origTransition = indicator.style.transition;
        indicator.style.transition = 'none';
        indicator.style.width = activeBtn.offsetWidth + 'px';
        indicator.style.transform = `translateX(${tx}px)`;
        indicator.offsetHeight;
        indicator.style.transition = origTransition;
    } else {
        indicator.style.width = activeBtn.offsetWidth + 'px';
        indicator.style.transform = `translateX(${tx}px)`;
    }
};

const applyLang = (skipTransition = false) => {
    const elSubtitle = document.getElementById('appSubtitle');
    const elGuideTitle = document.getElementById('guideTitleText');
    const elGuideStep1 = document.getElementById('guideStep1');
    const elGuideStep2 = document.getElementById('guideStep2');
    const elGuideStep3 = document.getElementById('guideStep3');
    const elUploadPrompt = document.getElementById('uploadPrompt');
    const elReselectBtn = document.getElementById('reselectBtn');
    const elStartRecBtnText = document.getElementById('startRecBtnText');
    const elStopRecBtnText = document.getElementById('stopRecBtnText');
    const elPlayPauseBtn = document.getElementById('playPauseBtn');
    const elLangOptZh = document.getElementById('langOptZh');
    const elLangOptEn = document.getElementById('langOptEn');

    if (elSubtitle) elSubtitle.textContent = t('subtitle');
    if (elGuideTitle) elGuideTitle.textContent = t('guideTitle');
    if (elGuideStep1) elGuideStep1.textContent = t('guideStep1');
    if (elGuideStep2) elGuideStep2.textContent = t('guideStep2');
    if (elGuideStep3) elGuideStep3.textContent = t('guideStep3');
    if (elUploadPrompt) elUploadPrompt.textContent = t('uploadPrompt');
    if (elReselectBtn) elReselectBtn.textContent = t('reselectBtn');
    if (elStartRecBtnText) elStartRecBtnText.textContent = t('startRecBtn');
    if (elStopRecBtnText) elStopRecBtnText.textContent = t('stopRecBtn');
    if (elPlayPauseBtn) elPlayPauseBtn.title = currentLang === 'zh' ? '播放/暂停' : 'Play/Pause';

    if (elLangOptZh) elLangOptZh.classList.toggle('active', currentLang === 'zh');
    if (elLangOptEn) elLangOptEn.classList.toggle('active', currentLang === 'en');

    updateLangIndicator(skipTransition);
    updateStatus(t(currentStatusKey, currentStatusArg), currentStatusIsRec);
};

const setLang = (lang) => {
    if (lang === currentLang) return;
    currentLang = lang;
    localStorage.setItem('tesla_dashcam_lang', currentLang);
    applyLang();
};

window.i18n = i18n;
window.t = t;
window.setLang = setLang;
window.applyLang = applyLang;
window.updateStatus = updateStatus;
