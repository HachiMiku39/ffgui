# FFGui

基于 Electron + FFmpeg 的桌面音视频工具箱（GUI for FFmpeg），界面语言为简体中文。

## 功能

### 音视频转码

- 批量队列转码：拖入或选择多个文件，按队列顺序逐个处理，实时显示每个文件的进度
- 能力自动探测：首次启动时通过 `ffmpeg -hwaccels / -encoders / -formats` 探测本机真实支持的
  硬件加速、编码器、封装格式并缓存；硬件编码器会逐个试编码实测，驱动不支持的自动剔除
  （如 NVENC / QSV / AMF / MediaFoundation / VideoToolbox）
- 常用格式与编码：MP4 / MKV / AVI / MOV / WebM / GIF / MP3 / FLAC 等，
  H.264 / H.265 / AV1 / VP9 / ProRes 等
- 高级参数：视频码率（VBR / CBR）、音频码率、分辨率缩放（宽x高 或百分比），
  留空则不传参，由 ffmpeg 使用默认值
- HDR 转 SDR：基于 zscale + tonemap 的色调映射
- 纯音频提取：输出 MP3 / FLAC / WAV 等时自动去掉视频流

### DSD 转 PCM（基于 v0.6.0 新增）

- 独立页面批量导入 DSF / DFF，读取真实文件头识别 DSD 倍率、采样率家族与声道；SACD ISO 需先提取为 DSF / DFF
- 默认输出 24-bit FLAC，可选 24-bit WAV 或 32-bit 浮点 WAV
- 常见 44.1 kHz 家族：DSD64 → 88.2 kHz，DSD128 / 256 / 512 → 176.4 kHz；48 kHz 家族对应 96 / 192 kHz
- 这是本项目的默认选率策略，不代表 DSD 与 PCM 存在统一音质等价关系；96 / 192 kHz 的非整数比例转换也不必然劣化
- 保留源声道、可支持的文字标签和 FLAC 内嵌封面；WAV 不写内嵌封面
- 默认不额外增加 6 dB；转换前扫描峰值，24-bit 输出会削波时拒绝该文件并提示降低增益，浮点 WAV 超幅时保留数据并提示
- 支持批量进度、取消与输出文件避让；原始 DSF / DFF 不改写

完整规则、格式限制与交接说明见 [DSD 转 PCM 功能说明](docs/dsd-pcm.md)。本功能分支仍使用版本号 `0.6.0`，正式版本号由上游维护者决定。

### 音视频合并

- 拖入视频或音频，按住手柄上下拖动调整拼接顺序
- 纯音频队列：只拼接音频（无损重采样对齐）
- 混合队列：自动重编码拼接，不同格式/分辨率可直接混合；
  队列中的音频文件会以黑屏画面合并进视频，无音轨的视频段自动补静音

### 画面裁剪

- 单文件可视化画框：选择或拖入一个视频，原生播放器暂停到某一帧后，
  点击「绘制裁剪框」在视频实际显示画面上拖拽框选要保留的区域，
  支持任意方向拖拽、边界钳制、选框外压暗，框太小直接判无效
- 选框按画面比例保存为归一化坐标（0~1），与预览画质无关；
  浏览器放不了的格式会自动生成低画质预览副本用于播放与画框，
  最终转换始终使用原文件，输出 MP4 / H.264 / AAC 并保留全部音轨
- 可调输出质量（高 / 标准 / 低）与输出目录，支持进度显示与取消；
  导出宽高会向下取偶数（如 1919→1918），已有文件自动避让不覆盖

### 光盘抓取

- 支持 DVD / Blu-ray 的 ISO 镜像、已提取目录（VIDEO_TS / BDMV）和物理光驱
- 探测标题、时长、章节、音轨和字幕语言；默认选最长标题，可多选标题逐条抓取
- 音轨/字幕三态选择：全部保留、一条不保留、或逐项指定，避免静默丢轨
- 无损 MKV：直接复制视频流；转码 MKV / MP4：H.264 + 可选 AAC，
  质量高/标准/低，保留章节；MP4 不支持 PGS / VobSub 图像字幕，需主动选择不保留
- 加密蓝光需自备本地 KEYDB.cfg；在线密钥服务不启用
- 物理光驱与加密盘的兼容性仍需真机验证

## 运行与开发

### 音轨与输出文件

- 转码默认保留全部音轨；可填写从 1 开始的音轨序号，只输出指定轨道。批量任务使用每个文件自己的音轨顺序。
- MP3、FLAC、WAV、FLV 使用单音轨模式，多音轨输入须明确选轨；不会自动丢弃其他音轨。需要全部音轨时可选择 MKV 或 M4A 等格式。
- MKV 转码同时保留字幕和附件；其他转码容器仅输出所选视频、音频，不自动转换字幕或附件。
- 无损截取映射全部原始流；若原格式无法重新封装某类流，任务会报错，不静默丢弃。时间输入与滑块保留毫秒，无损切仍受关键帧限制。
- 画面裁剪输出单个 MP4（H.264 + AAC），选框为相对视频画面的归一化矩形，按原视频实际分辨率等比例换算后裁剪；预览副本上框选的区域与输出区域按同一比例对应。
- 合并按音轨序号逐路拼接，缺轨片段补静音。合并前需确保各文件语言轨顺序一致；每条音轨沿用 44.1 kHz 双声道重采样规则。
- 转码、截取、合并遇到已有文件或批内同名输出时自动编号，避免覆盖源文件和历史结果。

### 回归测试

`npm test` 使用 Node 内置测试运行器，覆盖音视频回归、光盘任务与侧车协议、光盘页面、DSD 转换与 DSD 页面，无需额外测试框架。也可分别使用 `npm run test:regression`、`npm run test:disc`、`npm run test:dsd`。测试环境需要 ffmpeg 和 ffprobe，也可以用 `FFMPEG`、`FFPROBE` 指定路径；FFmpeg 需要包含 libx264、AAC、libmp3lame、FLAC、DSD 解码和 subtitles 滤镜。

测试生成独立临时媒体并在结束后清理。DSD 专项使用合成的短 DSF / DFF，通过真实 FFmpeg 转换并用 ffprobe 核对输出；页面专项是 Node 中的页面逻辑回归，不代表完整 Electron 应用已经人工操作验证。

### GitHub 云端验证与打包

本功能分支使用 GitHub Actions 执行测试、安装依赖、编译 Rust 侧车及打包，不要求本地编译。

- 向 `feat/dsd-pcm-adaptive` 推送后，自动触发「打包产物」，先在其中执行「DSD 与回归验证」；Pull Request 单独触发验证
- 验证使用 Ubuntu 24.04、Node 22 与 BtbN 固定发布的 FFmpeg / ffprobe 预编译二进制，下载后核对 SHA-256；日志作为 Actions artifact 保存 14 天
- 打包工作流复用相同验证，当前提交通过后才开始 Windows x64、Windows ARM64、macOS ARM64 三个平台的构建；Windows x64 与 macOS 另用实际随包 FFmpeg 执行 DSD 专项，Windows ARM64 保留交叉构建的机器类型检查；既有 Rust 光盘侧车继续随包提供
- 在对应 Actions run 的 **Artifacts** 区下载压缩包和 Windows 安装包。功能分支推送与手动构建仅提供测试产物，不自动发布 Release；仅既有的 Release 发布事件会上传到 Release Assets
- 尚未验证的真实音乐、完整 GUI、DAC 播放与实际设备兼容性见 [交接文档](docs/dsd-pcm.md#验证范围与状态)
- 仅修改 Markdown 文档的功能分支 push 不重新编译；需要时仍可手动运行工作流

上游常规开发入口保留如下；本次新增功能的验收结果以 GitHub Actions 日志为准：

```bash
npm install
npm start          # 开发运行
npm run package    # 打包（输出到 out/）
npm run make       # 生成安装包（Windows: NSIS / macOS: zip / Linux: deb、rpm）
```

### ffmpeg 获取

- **Windows**：下载 ffmpeg 构建（推荐 [gyan.dev full 构建](https://www.gyan.dev/ffmpeg/builds/)），
  将 `ffmpeg.exe` 放入项目 `bin/` 目录（详见 `bin/README.md`）
- **macOS**：`brew install ffmpeg`
- **Linux**：使用发行版包管理器安装 ffmpeg（走系统 PATH）

## 技术栈

- Electron 41，无前端框架、无打包器：渲染层为原生 HTML / CSS / JS
- 主进程负责 ffmpeg 能力探测与缓存、文件对话框、spawn ffmpeg 并解析 `-progress` 进度输出
- 光盘抓取由 Rust 侧车调用 freemkv-engine 完成读盘与无损封装，FFmpeg 负责后续转码
- 渲染进程通过 preload 的 contextBridge 访问受限 IPC API（contextIsolation 开启）

## 许可证

LGPL-3.0-or-later
