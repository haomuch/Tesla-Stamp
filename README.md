# Tesla Dashcam Stamp (特斯拉行车记录仪水印工具)

![Tesla Dashcam Stamp](https://img.shields.io/badge/Tesla-Dashcam-red?style=for-the-badge&logo=tesla)
![License](https://img.shields.io/badge/License-MIT-black?style=for-the-badge)
![Platform](https://img.shields.io/badge/Platform-Web-blue?style=for-the-badge)

**Tesla Dashcam Stamp** 是一款专为特斯拉车主设计的开源网页版视频水印工具。它能够自动从特斯拉行车记录仪导出的原始 MP4 文件中提取隐藏的遥测数据（如时速、油门、刹车、自动驾驶状态等），并将其美观地叠加热合成到视频中，支持本地高性能合成与导出。

---

## ✨ 核心特性

- 🛡️ **隐私至上**：100% 纯客户端处理。所有视频解析、数据提取和画面合成均在您的浏览器内完成，**绝不上传任何数据到服务器**。
- 📊 **深度遥测数据提取**：
  - **实时车速** (km/h)
  - **加速踏板深度** (%)
  - **刹车状态** (ON/OFF)
  - **自动驾驶状态** (NONE / TACC / Autosteer 等)
  - **精准时间戳**：自动解析 SEI 元数据或文件名，还原真实的驾驶时刻。
- ⚡ **高性能架构**：
  - **WebGL 2.0 渲染**：利用显卡硬件加速叠加热合水印，保证流畅的预览体验。
  - **WebCodecs 硬件编码**：采用现代浏览器 `VideoEncoder` API，实现极速视频导出。
- 🎨 **特斯拉美学 UI**：采用深色模式与玻璃拟态设计，延续特斯拉科技感。
- 📱 **多端兼容**：优化了 iOS Safari 与微信浏览器的兼容性，支持移动端操作。

---

## 🚀 快速开始

1. **访问地址**：直接在浏览器中打开 `index.html`。
2. **导入视频**：点击上传区域或将特斯拉记录仪导出的 MP4 文件（例如 `2024-04-02_14-15-54-front.mp4`）拖入页面。
3. **预览与跳转**：等待数据解析完成后，您可以随意拖动进度条预览带水印的画面。
4. **合成导出**：
   - 点击 **“开始合成”**。
   - 页面将进行逐帧渲染（此时请勿离开浏览器标签页以保证编码连续性）。
   - 完成后点击 **“保存视频”** 即可下载带水印的成品文件。

---

## 🛠️ 技术实现

本项目的核心逻辑完全由原生 JavaScript 实现，无需复杂的后端支撑：

- **MP4 解析器**：手写 `DashcamMP4` 类，深度解析 MP4 Box 结构（mdat/moov/stbl等），提取隐藏在 SEI NAL 单元中的 Protobuf 数据。
- **Protobuf 解码**：利用 `protobuf.js` 解析特斯拉定义的车辆状态协议，获取高频物理参数。
- **混合渲染管线**：
  - `Canvas 2D` 负责高效率的水印文本布局。
  - `WebGL 2.0` 负责将视频帧与水印图层进行 Alpha 混合与色彩空间处理。
- **视频封装**：集成 `mp4-muxer`，将编码后的 H.264 原始流实时封装为符合标准的 MP4 容器。

---

## 📦 依赖项

项目运行依赖以下库（已包含在 `public/` 目录下）：
- [mp4-muxer](https://github.com/viahous/mp4-muxer) - 高性能 MP4 封装库。
- [protobuf.js](https://github.com/protobufjs/protobuf.js) - Google Protobuf 解码/编码。

---

## ⚠️ 免责声明

1. 本工具仅供个人学习与驾驶行为记录参考使用。
2. 所提取的遥测数据（如速度、加速度等）来源于视频文件中的元数据，其精度由车辆传感器决定。
3. 请确保您的浏览器支持 `WebCodecs` 与 `WebGL 2.0`（推荐使用最新版 Chrome、Edge 或 Safari）。

---

## 📜 开源协议

本项目基于 [MIT License](LICENSE) 协议开源。

---
*Inspired by the innovation of Tesla and the open-source community.*
