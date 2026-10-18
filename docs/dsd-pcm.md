# DSD 转 PCM：功能规则与交接说明

本功能基于 [FFGui v0.6.0](https://github.com/kisaragychihaya/ffgui/releases/tag/v0.6.0) 增加独立的 DSD 转 PCM 页面。功能分支为 `feat/dsd-pcm-adaptive`，保留项目版本号 `0.6.0`，由上游维护者决定合并与后续正式版本。

本文中的默认选率属于本项目的产品策略；工具、文件格式和信号处理事实另列官方参考资料。测试与打包由 GitHub Actions 完成，验证状态见文末。

## 功能范围

输入为 DSF / DFF 文件，输出为普通 PCM WAV 或 FLAC。批量队列按每个输入文件的真实规格分别选择采样率，源文件保持原样。

SACD ISO 需先提取为 DSF / DFF，再加入本页面。DoP 是传输 DSD 数据的封装方式，不属于这里的 PCM 转换结果。

## 默认转换规则

### 1. 读取真实规格

直接读取文件头中的 DSD 位采样率、声道及格式信息，不从文件名中的 DSD64 / 128 / 256 / 512 文本猜测，也不把 FFmpeg 显示的中间解码采样率直接当成原始 DSD 位采样率。

这个区别有实际影响：例如 FFmpeg 6.1 的 DSF 读取器会把头部位采样率除以 8 后报告；DSD64 在这种口径下显示为 352800 Hz。自动识别不能再用这个数字当作 2822400 Hz。[FFmpeg 6.1 DSF 读取器源码](https://ffmpeg.org/doxygen/6.1/dsfdec_8c_source.html)

损坏、截断、头部规格不受支持的输入应显示明确错误，不静默按默认 DSD64 继续转换。读取文件头时按块访问，使用安全长度检查，不把整首大体积 DSD 文件读入内存。

### 2. 按采样率家族自动选择输出

常见 DSD 使用 44.1 kHz 家族。本项目默认 DSD64 使用 88.2 kHz，DSD128 / 256 / 512 使用 176.4 kHz，上限不随 DSD 倍率无限增加。

| 源规格 | 原始 DSD 位采样率 | 默认 PCM 采样率 | 默认成品位深 | 总降采样比例 |
|---|---:|---:|---|---:|
| DSD64 | 2,822,400 Hz | 88,200 Hz | 24-bit 整数 | ÷32 |
| DSD128 | 5,644,800 Hz | 176,400 Hz | 24-bit 整数 | ÷32 |
| DSD256 | 11,289,600 Hz | 176,400 Hz | 24-bit 整数 | ÷64 |
| DSD512 | 22,579,200 Hz | 176,400 Hz | 24-bit 整数 | ÷128 |

较少见的 48 kHz 家族使用相同策略：

| 源规格 | 原始 DSD 位采样率 | 默认 PCM 采样率 | 默认成品位深 |
|---|---:|---:|---|
| DSD64（48 kHz 家族） | 3,072,000 Hz | 96,000 Hz | 24-bit 整数 |
| DSD128（48 kHz 家族） | 6,144,000 Hz | 192,000 Hz | 24-bit 整数 |
| DSD256（48 kHz 家族） | 12,288,000 Hz | 192,000 Hz | 24-bit 整数 |
| DSD512（48 kHz 家族） | 24,576,000 Hz | 192,000 Hz | 24-bit 整数 |

两组真实 DSD 频率可参考 [exaSound 官方规格](https://www.exasound.com/Products/e62DAC.aspx)。以上 PCM 输出是本项目选择，并非该厂商规定的转换对应表。

44.1 kHz 家族 DSD 转为 96 / 192 kHz 也是有效的采样率转换，需要正确的非整数比例 SRC；非整数比例本身不代表必然出现可闻损失。本项目沿用源家族作为自动默认值，不把其他有效采样率称为错误。可参考 [XLD 官方 DSD 说明](https://tmkk.undo.jp/xld/dsd.html.en) 对整数抽取及其他采样率转换路径的说明。

采样率选择器也提供 88.2 / 96 / 176.4 / 192 / 352.8 / 384 kHz 手动选项。手动指定会应用于当前批次；选择「自动」则每个文件分别按自身规格选择。

### 3. 输出格式与位深

| 输出选项 | 编码形式 | 用途 |
|---|---|---|
| FLAC 24-bit（默认） | 24-bit 整数 PCM，经 FLAC 无损压缩 | 收藏与播放 |
| WAV 24-bit | 24-bit 整数 PCM | WAV 工作流或后续软件要求 |
| WAV 32-bit 浮点 | 32-bit float PCM | 后续增益、EQ、混音等处理的中间文件 |

相同采样数据的 WAV 与 FLAC 解码后音频相同。FLAC 对转换所得 PCM 无损，不意味着可以逐位恢复原始 DSD；DSD 与 PCM 没有统一的音质等级换算。

现代 FLAC 支持 32-bit 整数，但不支持浮点。此功能不把 32-bit 整数 FLAC 列为默认选项，也不把 32-bit float WAV 当作比 24-bit 成品必然更高的听感等级。[FLAC FAQ](https://xiph.org/flac/faq.html)

### 4. 滤波、抖动与电平

DSD 转 PCM 必须正确低通并抽取 / 重采样，不能简单隔若干位取一个数。输出采样率与 DSD 超声量化噪声滤波是相关但不同的参数；高输出采样率不自动保证超声噪声已经得到适当处理。[FFmpeg DSD 解码实现](https://ffmpeg.org/doxygen/6.1/dsd_8c_source.html)

默认不额外增加 6 dB。某些解码器的参考电平约定可能涉及增益补偿，但盲目重复补偿可能导致削波；应结合已使用的解码器与实际输出峰值判断。[Weiss SARACON 手册](https://weiss.ch/wp-content/uploads/2023/02/saracon-manual-win.pdf)

转换分为峰值扫描与最终输出两阶段。扫描与导出使用一致的滤波、采样率及增益设置，以浮点峰值决定是否允许输出：

- 24-bit 整数：处理后峰值接近满幅或超出满幅时拒绝该文件，并提示建议降低到的增益；不自动逐曲改变增益。
- 32-bit float WAV：允许保留超过 0 dBFS 的浮点采样，同时提示播放或最终转整数前降低增益。
- 无法确认峰值、采样为空或含 NaN / Inf：不生成输出。
- 增益可在高级设置中手动选择 -12～+6 dB，默认 0 dB。需要调整专辑时建议各曲使用相同增益，保持相对电平。

不会主动提高低电平曲目的音量。批量转换不应被解释为专辑响度标准化。

处理尽量保持浮点精度，最终输出整数 PCM 时才做量化与 TPDF 抖动；浮点 WAV 不套用整数位深的抖动流程。[FFmpeg 重采样器文档](https://ffmpeg.org/ffmpeg-resampler.html)

当前路径通过 FFmpeg `swr` 的 Kaiser FIR 进行低通与采样率转换：`filter_size=256`、`kaiser_beta=12`、内部双精度、30 kHz 的 -6 dB 截止点策略。截止比例按实际输入 / 输出采样率计算，以覆盖手动升采样的情况。该滤波选择与输出采样率分别有明确含义，手动选择更高输出率不会自动扩展滤波带宽。源 DSD 的解码仍由 FFmpeg 自身实现；这里没有把输出规格或某套滤波参数宣称为主观音质保证。

## 声道、标签与输出安全

- 保留输入的声道数量与布局，不默认把多声道降为双声道。源容器和所用编码器的声道限制仍适用；不支持时明确报错。
- 保留输入中可识别、且目标容器可表示的文字标签；不同容器的标签字段不能承诺逐项原样复制。
- FLAC 可保留已探测到的内嵌封面：JPEG / PNG 原样复制，其他可解码图片转为 JPEG。WAV 不写内嵌封面，探测到源封面且请求保留时发出警告。
- 默认输出到源文件目录，可改为指定目录。文件名沿用源文件名主体并更换扩展名；输出路径避开全部输入、已有文件及当前批次目标，重名增加 `_2`、`_3` 等编号。
- 转换先写目标目录中的任务独立临时目录，仅成功完成后才以无覆盖方式发布最终文件；扫描与导出期间检查源文件是否发生变化。
- 取消同时终止峰值扫描或转换阶段，清理由本次任务产生的半成品；已存在的文件与此前成功输出保持原样。
- 源文件不改写；长期归档建议保留 DSF / DFF 原件。

## 使用流程

1. 在首页进入「DSD 转 PCM」，选择或拖入一个或多个 DSF / DFF。
2. 检查逐文件识别到的规格与预计输出，确认自动选择的采样率。
3. 选择 FLAC 或 WAV；WAV 的 32-bit 浮点选项位于高级设置。默认使用自动采样率、24-bit 整数、0 dB 增益与源目录，也可按需求调整。
4. 开始批量任务，查看峰值扫描及转换进度；需要中止时使用取消。
5. 检查完成项和错误 / 警告，按实际输出路径收集文件。

## 代码与开发入口

音频处理继续使用项目已有 FFmpeg 能力，主进程负责校验参数、路径、子进程和输出管理，渲染进程经 preload 暴露的受限接口调用。DSD 专项模块为 `main/dsd.js`，通过 `registerDsdIpc()` 注册；复用 `main/ffmpeg.js` 的 FFmpeg 子进程、进度和取消机制。

DSD 任务持有共享任务占用标记，覆盖探测、峰值扫描及最终转换，避免两个阶段之间被其他转换任务插入。渲染层沿用 `onConvertEvent` 订阅 `ffgui:convert-event`，通过 `phase: scan / convert` 区分两个阶段，取消沿用 `cancelConvert()`。

本次不增加运行时 npm 依赖，不把 FFprobe 加入应用安装包。FFprobe 只用于云端测试核对输出，应用本身使用文件头与现有 FFmpeg 探测路径。

| 文件 | 职责 |
|---|---|
| `main/dsd.js` | DSF / DFF 文件头识别、选率策略、参数校验、峰值检查、输出与 IPC |
| `main/ffmpeg.js` | 共用子进程、进度、输出命名、任务占用和取消 |
| `preload/preload.js` | 最小化暴露 DSD 文件选择、探测与转换接口 |
| `html/dsd.html`、`html/js/dsd.js`、`html/css/dsd.css` | 独立 DSD 页面、批量队列、表单、预期输出及任务状态 |
| `scripts/dsd.test.cjs` | DSD 文件头、参数、真实 FFmpeg 转换及任务管理验证 |
| `scripts/dsd-ui.test.cjs` | DSD 页面行为与受限接口回归 |
| `.github/workflows/dsd-check.yml` | Node 22 与 FFmpeg 云端验证，可被打包工作流复用 |
| `.github/workflows/build.yml` | 验证通过后构建 Windows x64、Windows ARM64、macOS ARM64 产物 |
| `docs/dsd-pcm.md` | 默认转换规则、功能边界与交接说明 |

### DSD 接口与参数

| preload 方法 | IPC 通道 | 作用 |
|---|---|---|
| `dsdPickFiles()` | `ffgui:dsd-pick-files` | 打开 DSF / DFF 多选对话框 |
| `dsdProbe(files)` | `ffgui:dsd-probe` | 逐文件返回真实 DSD 规格，错误附在对应结果 |
| `dsdConvert(job)` | `ffgui:dsd-convert` | 启动一批 DSD 转换 |

`job` 参数由主进程再次校验：

| 字段 | 值 / 默认值 |
|---|---|
| `inputs` | 1～1000 个本地绝对路径 |
| `format` | `flac` / `wav`，默认 `flac` |
| `sampleRate` | `auto` 或数值 `88200` / `96000` / `176400` / `192000` / `352800` / `384000` |
| `bitDepth` | `24` / `32f` 字符串，默认 `24`；`32f` 仅接受 WAV |
| `gainDb` | -12～+6 范围内的有限数值，默认 `0` |
| `outputDir` | 本地绝对路径；留空使用各源文件目录 |
| `copyMetadata` | 布尔值，默认 `true` |
| `copyCover` | 布尔值，默认 `true`；FLAC 支持封面输出 |

不向渲染层开放任意 FFmpeg 参数或命令执行接口。界面沿用原有 CSP、主题与 `contextIsolation` 设置。

## GitHub Actions 云端流程

### 自动触发

推送 `feat/dsd-pcm-adaptive` 会运行「打包产物」，先在其中调用「DSD 与回归验证」。Pull Request 独立运行验证；两个工作流均保留手动触发入口。

「打包产物」调用相同验证工作流，并要求本次提交的验证成功后才开始三平台构建。功能分支 push 仅执行一次完整 Ubuntu 回归，独立验证入口用于 PR 或手动检查。Windows x64 与 macOS 在下载自己的 FFmpeg 后另外执行 DSD 专项，以检验实际随包二进制，避免只验证 Ubuntu 的另一版本。

### 验证环境

- Ubuntu 24.04、Node.js 22。
- 使用发行版 FFmpeg / ffprobe，版本写入日志。
- Node 内置测试运行器，无需为验证安装 Electron、执行应用打包或编译 Rust。
- `npm run test:regression`：既有音视频回归。
- `npm run test:disc`：既有光盘任务、侧车协议和页面回归。
- `npm run test:dsd`：DSD 转换与页面回归。

日志在对应 Actions run 的 Artifacts 区保存 14 天，名称以 `dsd-check-` 开头。测试使用 `FFMPEG` / `FFPROBE` 环境变量选择二进制。只要工具准备成功且任务未取消，各测试组会分别运行，即使某一组失败也尽量保留其他组的诊断结果；任一组失败仍会阻止后续打包。

### 构建产物

沿用上游三种构建目标与原有 FFmpeg 下载来源，Rust 光盘侧车仍按各自架构构建和携带。

Windows x64 与 macOS 在打包前运行 `node --test scripts/dsd.test.cjs`，`FFMPEG` / `FFPROBE` 指向该平台刚下载的二进制。Windows 的 ffprobe 仅从展开包中引用，不复制进安装包；macOS 使用原有下载布局中的 `bin/bin/ffprobe`。专项失败则停止该平台打包，不重复运行全部旧功能回归。

| 目标 | Actions artifact | 内容 |
|---|---|---|
| Windows x64 | `FFGui-windows-x64` | `FFGui-windows-x64.7z` |
| Windows x64 安装包 | `FFGui-windows-x64-Setup` | `FFGui-0.6.0-x64-Setup.exe` |
| Windows ARM64 | `FFGui-windows-arm64` | `FFGui-windows-arm64.7z` |
| Windows ARM64 安装包 | `FFGui-windows-arm64-Setup` | `FFGui-0.6.0-arm64-Setup.exe` |
| macOS ARM64 | `FFGui-macos-arm64` | `FFGui-macos-arm64.zip` |

Windows ARM64 使用交叉构建并验证 PE 架构，不将 x64 runner 上的编译结果称为 ARM64 真机运行验证。macOS 包沿用现有分发方式，应用启动与 DAC 播放仍需实机验证。

功能分支 push 与手动构建仅上传 Actions artifacts。工作流不会替维护者创建正式 Release；既有 `release: published` 事件的 Release Assets 上传逻辑保留。

## 验证范围与状态

以下为本次交接的验收项目。合成数据验证结果以对应提交的 GitHub Actions 日志为准，文档初始状态列为待 CI 确认，不预先宣称通过。

| 范围 | 验证方式 | 当前状态 |
|---|---|---|
| 两个采样率家族、DSD64 / 128 / 256 / 512 识别与默认映射 | 合成 DSF / DFF、头部解析回归 | 待 CI 确认 |
| WAV 24-bit / 32-bit float、FLAC 24-bit 实际输出 | 真实 FFmpeg 转换、ffprobe 检查 | 待 CI 确认 |
| 声道、标签、封面 | 合成媒体与输出探测 | 待 CI 确认 |
| 无效输入、参数白名单、输出防覆盖、峰值与取消 | Node 回归及合成媒体 | 待 CI 确认 |
| DSD 页面与 preload 调用约束 | Node 页面逻辑回归 / 静态检查 | 待 CI 确认 |
| 既有音视频与光盘功能 | 原有 Node 回归脚本 | 待 CI 确认 |
| Windows x64 / macOS 实际随包 FFmpeg 的 DSD 专项 | 对下载二进制执行 DSD 测试 | 待 CI 确认 |
| 三平台安装包 / 压缩包 | GitHub Actions 构建 | 待 CI 确认 |
| 真实专辑、各种来源的 DFF / DST、完整 Electron GUI | 手工导入、批量操作与听音 | 尚未人工验证 |
| 真实 DAC、多声道播放设备、Windows ARM64 真机 | 实机启动与播放 | 尚未实机验证 |

合成短文件可以检验解码路径、格式字段和任务行为，不能代表对全部音乐母带、全部元数据写法、所有 DAC 或主观音质完成验证。

## 采用的开源工具与参考资料

| 工具 / 资料 | 本功能中的作用 | 链接 |
|---|---|---|
| FFmpeg | DSD 解码、PCM 处理、WAV / FLAC 输出 | [官网](https://ffmpeg.org/) · [重采样器文档](https://ffmpeg.org/ffmpeg-resampler.html) · [许可说明](https://ffmpeg.org/legal.html) |
| FFprobe | 云端测试核对输出采样率、位深、声道及元数据 | [官方文档](https://ffmpeg.org/ffprobe.html) |
| Electron | 沿用项目桌面外壳与主进程 / preload / 渲染进程架构 | [官网](https://www.electronjs.org/) |
| Node.js 内置测试运行器 | 无额外测试框架的回归测试 | [Node.js 22 文档](https://nodejs.org/docs/latest-v22.x/api/test.html) |
| FLAC 官方资料 | 整数位深、无损压缩和浮点限制说明 | [FAQ](https://xiph.org/flac/faq.html) |
| XLD 官方 DSD 说明 | 整数抽取与其他采样率转换的参考 | [官方说明](https://tmkk.undo.jp/xld/dsd.html.en) |

本功能直接使用 FFmpeg 的 FLAC 编码器，不额外要求 libFLAC 或 libsoxr。已有 Electron Forge、Rust 光盘侧车及其依赖继续由上游构建配置管理。
