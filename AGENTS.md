# AGENTS.md

本文件面向 AI 编码代理，假设读者对本项目一无所知。

## 项目概览

FFGui 是一个基于 Electron 的桌面音视频工具箱（GUI for FFmpeg），个人开源项目（LGPL-3.0-or-later），界面语言为简体中文。已实现五个功能：「音视频转码」「音视频合并」「音视频截取」（无损切 + 抓帧截图）「画面裁剪」（单文件可视化画框）「屏幕录制」。

应用通过项目内置的 ffmpeg 执行实际处理：主进程负责探测 ffmpeg 能力（硬件加速 / 编码器 / 封装格式）并缓存、弹文件对话框、spawn ffmpeg 子进程并解析其 `-progress` 输出；渲染进程为纯静态 HTML/CSS/JS 页面。屏幕录制的采集与编码在渲染进程完成（系统选择器 + MediaRecorder），仅结果转 MP4 时走 ffmpeg。

## 技术栈

- Electron 41（`package.json` 中 `devDependencies.electron`），CommonJS（`"type": "commonjs"`），Node 22（CI）
- 无前端框架、无打包器、无 TypeScript：渲染层就是原生 HTML + CSS + ES6+ 风格 IIFE 脚本
- 打包工具：Electron Forge 7（`forge.config.js`），makers：本地 NSIS maker（Windows，见下文「NSIS 安装包」）、zip（macOS）、deb/rpm（Linux）
- `.npmrc` 配置了 npmmirror 的 Electron 镜像（`electron_mirror`），安装依赖在国内网络下进行
- 打包时的 JS/HTML/CSS 压缩（terser / html-minifier-terser / clean-css）是 devDependencies，通过 `forge.config.js` 的 `packageAfterCopy` 钩子执行

## 目录结构与模块划分

```
index.js            主进程入口：创建 BrowserWindow（1080x720，contextIsolation: true，
                    nodeIntegration: false），app ready 后调用 main/ffmpeg.registerIpc()
                    与 main/theme（initTheme 应用持久化主题 + registerThemeIpc）；
                    开发模式自动开 DevTools，打包后拦截 devtools-opened 强制关闭
main/theme.js       主题设置：持久化用户选择（system/light/dark）到
                    userData/config.json 的 theme 字段，经 nativeTheme.themeSource
                    强制 prefers-color-scheme 全局生效；IPC：ffgui:theme-get /
                    ffgui:theme-set（校验合法性 → 持久化 → 改 themeSource →
                    向所有窗口广播 ffgui:theme-changed）
main/ffmpeg.js      主进程核心：
                    - getFfmpegPath：Windows 用 bin/ffmpeg.exe（开发读项目根、打包读
                      resources/bin/，按 app.isPackaged 区分）；macOS 优先内置
                      bin/bin/ffmpeg，未内置时回退 Homebrew（/opt/homebrew/bin、
                      /usr/local/bin、PATH），找不到返回 null 由上层提示 brew install；
                      Linux 直接用系统 PATH 的 ffmpeg
                    - 能力探测：运行 ffmpeg -version/-hwaccels/-encoders/-formats，
                      解析输出并缓存到 userData/ffmpeg-caps.json（CACHE_VERSION = 4，
                      解析逻辑变更时需递增此版本号使旧缓存失效；同时校验 ffmpeg
                      版本字符串，变化也会重新探测）
                    - 硬件编码器实测：首次探测时对 *_nvenc/_qsv/_amf/_mf/_vaapi/_vulkan
                      等硬件编码器各试编码 1 帧（256x256，过小会触发最小分辨率限制
                      造成误判）到 null 设备，失败者在编码器条目上标 broken: true，
                      转码页下拉框会剔除；首页"清除硬件信息缓存"按钮可删除缓存重新探测
                    - 转码任务：spawn ffmpeg，参数含 -nostats -progress pipe:1，
                      解析 stdout 的 key=value 进度块，通过 'ffgui:convert-event'
                      推送 file-start / progress / file-done / file-warning /
                      file-error 事件
                      （spawn/日志/进度解析封装在 runFfmpegTask，转码、合并、截取、
                      预览、录屏转 MP4 共用）；设备预设（job.devicePreset）在主进程由
                      normalizeConvertJob 按 DEVICE_PRESETS 表二次落实（不能被旧
                      表单值覆盖，须在分配输出扩展名前调用），每个预设锁定
                      格式/编码器/Profile/Level/位深/帧率上限/分辨率/VBV 码率
                      三件套/音频码率/声道/采样率；预设清单（渲染层 convert.js
                      有同名表负责填表单与提示文案，键须一一对应）：
                      在线平台 bili-1080p（High 4.2/60fps/6000k 峰值 12000/
                      AAC 320k，B站免二压均值上限 6000）、bili-720p（High 3.1/
                      3000k/AAC 192k）、douyin-1080p（High 4.2/60fps/6000k/
                      AAC 192k）、wechat-1080p（High 4.0/4000k/AAC 128k）、
                      youtube-1080p（High 4.2/60fps/8000k 峰值 12000/AAC 384k）；
                      老设备 ipod4-540/ipod4-720（Main 3.1/30fps/2000k/AAC 128k）、
                      iphone4s（High 4.0/1080p30/4000k/AAC 160k，Apple 官方
                      1080p 播放上限）、psp（Main 2.2/480x272/1000k）、
                      android-legacy（Baseline 2.1/800x480/1000k/44.1kHz）；
                      通用 web-safe（Baseline 3.0/720p/2500k）、tv-4k（High 5.1/
                      2160p30/20000k 峰值 40000/AAC 192k，兼 B站 4K）；
                      全部为 MP4/libx264/yuv420p/保持比例/AAC-LC 双声道 + VBV +
                      faststart，默认第 1 音轨；H.264 Level 白名单含 2.1–5.2；
                      自定义高级参数（像素格式、Profile/Level、声道、
                      采样率、ID3 版本、标签/封面开关、30 秒试转）由
                      validateConvertOptions 白名单校验；固定帧率开放手填数字
                      （UI 为 input+datalist 快捷选项），主进程按 1–240 数值范围
                      校验（23.976/29.97/59.94 仍映射 24000/1001 等分数），
                      复制流与转码参数冲突直接报错；纯音频输出（MP3/M4A/FLAC）默认保留内嵌封面：
                      probeFile 返回 covers[]（attached pic 的流编号与编码），
                      只显式映射封面流，JPEG/PNG 原样复制、其他转 mjpeg，
                      多张封面保留类型；WAV/OGG/OPUS 不保留封面，仅发
                      file-warning 提示；-map_metadata 0 保留文字标签
                      （可关），MP3 显式 -id3v2_version（默认 3）；预设用到
                      -fpsmax 与 scale 的 reset_sar，需要较新 FFmpeg（5.1+/6.1+）
                      质量档仅对 CRF_ENCODERS 传 -crf；VideoToolbox
                      编码器不支持 -crf，在 darwin+arm64 下改传 -q:v（VT_QSCALE_MAP，
                      仅 h264/hevc_videotoolbox，ProRes 画质由 profile 决定故排除），
                      Intel Mac 传 -q:v 会报错故留空走编码器默认值；nvenc/qsv/amf
                      码率留空时按质量档传恒定画质参数（HW_QUALITY_ARGS：nvenc 用
                      -rc vbr -cq、qsv 用 -global_quality、amf 用 -rc qvbr
                      -qvbr_quality_level，数值复用 CRF_MAP，越小质量越高；
                      amf 参数未在真机验证过）
                    - 可视化裁剪（job.crop）：归一化矩形 {x, y, w, h}，相对视频实际
                      画面（0~1，与像素无关，预览副本上选的数值同样适用），x/y 为
                      左上角、w/h 为宽高；边界容差只吸收浮点误差
                      （CROP_EPS = 1e-6）。由 validateConvertOptions 校验（非法抛中文
                      错误；与 vcodec: 'copy' 同存直接拒绝），buildCropFilter 生成
                      crop 滤镜：普通区域按 in_w/in_h 等比例换算、宽高向下取偶兼容
                      yuv420p；极小合法区域会加固为宽高至少 2，且 x/y 必要时按
                      out_w/out_h 钳制，避免边缘越界（如 x+w 超出 1 的浮点误差）。
                      滤镜链顺序固定为 Crop → HDR → Scale：crop 必须位于
                      链首（基于滤镜实际输入尺寸），HDR→SDR 色调映射（zscale 线性光→
                      tonemap=hable→bt709）作用于裁剪后的画面，scale 追加在链尾
                    - 合并任务：probeFile 用 ffmpeg -i 的 stderr 探测流信息（时长/
                      有无音视频流/分辨率，attached pic 封面不算视频流）；混合队列用
                      concat filter 重编码拼接，纯音频段生成等长黑屏（color 源）、
                      无音轨视频段生成静音（anullsrc）；纯音频队列 concat v=0 只拼音频；
                      输出文件名为 merged_<时间戳>.<格式>（buildMergeOutputPath）；
                      可选字幕（job.subtitle = { path, mode }）：burn 硬字幕在 concat 后
                      经 subtitles 滤镜烧录（路径转义见 escapeSubtitleFilterPath：
                      正斜杠 + `\:` + 单引号包裹），embed 软字幕作为额外输入
                      -map 进容器（MKV -c:s copy、MP4 转 mov_text，lavfi 输入索引
                      相应后移 lavfiBase）；字幕时长探测 probeSubtitleDuration 直接
                      解析文本时间戳（ffmpeg -i 对字幕输出 Duration: N/A），支持
                      srt/vtt/ass/ssa；有字幕时允许只给 1 个音视频文件；纯音频
                      队列拒绝字幕
                    - 截取任务（runClip）：无损切，-ss 放 -i 前快速 seek + -c copy
                      流复制 + -avoid_negative_ts make_zero，不重编码；起点落在
                      <= 起点的最近关键帧，可能有偏差（截取页已提示）；输出与源文件
                      同目录同扩展名（复用 buildOutputPath 的 _ffgui 后缀规则）
                    - 预览副本（runPreview）：截取页与画面裁剪页中浏览器无法解码的格式
                      （wmv/flv 或封装非常规编码的 mkv/avi；普通 mkv Chromium 可直接播放）
                      自动转一份低码率副本（视频 960p/ultrafast/crf30 + aac 96k；纯音频
                      aac 128k）到 userData/preview-cache/（单槽位，生成前删旧），副本
                      与原片时间轴 1:1 对齐；截取页的截取与抓帧、裁剪页的最终转换始终
                      作用于原文件（裁剪页只用副本播放与画框，选框按画面比例保存，
                      后端再按原视频实际分辨率等比例换算）
                    - 抓帧截图（ffgui:captureFrame）：弹保存对话框后
                      ffmpeg -ss <t> -i <原文件> -frames:v 1 输出 PNG（原分辨率）
                    - 录屏采集授权（registerDisplayMediaHandler，注册在 defaultSession）：
                      Electron 的 useSystemPicker 仅 macOS 15+ 有效，Windows/Linux
                      必须由 handler 授予 desktopCapturer 来源。渲染进程在来源选择
                      弹窗里选定后先经 ffgui:prepareDesktopSource 登记来源 id，紧接着
                      调用 getDisplayMedia，handler 按登记授予（video 为所选来源；
                      audio 请求且 win32 时授予 'loopback' 系统声音回环——Electron
                      文档明确仅 Windows 支持，macOS/Linux 无系统级回环，只能录
                      麦克风；渲染层在开始录制时会校验"勾了系统声音但流里没有
                      音轨"并拦截，勾选发生在选择来源之后会自动按已登记的
                      sourceId 静默重新采集，来源失效才重开来源选择弹窗）
                    - 录屏写盘：渲染进程 MediaRecorder 按 1s 分块经
                      ffgui:recordWriteChunk 流式追加到主进程 fs.WriteStream
                      （recordStreams 按路径存流，write 等回调实现背压）；
                      recordStart 在开始录制时显式建流（同路径在录则报错），
                      writeChunk 绝不事后新建（'w' 会截断已完成的文件），停止后
                      迟到的分块会被拒绝；渲染层另有 starting/stopping/acceptChunks
                      防重入与分块接收窗口，杜绝并发/迟到写入截断文件；
                      recordPickOutput 弹保存对话框（默认 视频/record_<时间戳>.webm）；
                      recordFinish 关流返回大小；recordDiscard 删半成品；
                      recordRemux 把录制结果 WebM 转 MP4（-c:v copy 无损 +
                      Opus 转 AAC，无音轨传 -an，复用 runFfmpegTask 进度事件）；
                      getDesktopSources 枚举屏幕/窗口来源（含缩略图 data URL）
                    - IPC handler：ffgui:getCapabilities / clearCapsCache /
                      pickMediaFiles / pickDirectory / convert / cancelConvert /
                      probeMedia / merge / pickSubtitle / probeSubtitle /
                      clip / makePreview / captureFrame /
                      recordPickOutput / recordStart / recordWriteChunk /
                      recordFinish / recordDiscard / recordRemux /
                      getDesktopSources / prepareDesktopSource
                      （合并、截取、预览、录屏转 MP4 的进度与取消均复用 convert
                      的事件与 IPC）
preload/preload.js  通过 contextBridge 暴露 window.ffgui（platform、versions、
                    getCapabilities、clearCapsCache、pickMediaFiles、pickDirectory、
                    getPathForFile、convert、cancelConvert、onConvertEvent、
                    probeMedia、merge、pickSubtitle、probeSubtitle、clip、
                    makePreview、captureFrame、recordPickOutput、recordStart、
                    recordWriteChunk、recordFinish、recordDiscard、recordRemux、
                    getDesktopSources、prepareDesktopSource、pathToFileUrl、
                    getTheme、setTheme、onThemeChanged）
html/index.html     首页（功能导航卡片 + "清除硬件信息缓存"按钮）
html/convert.html   转码页
html/merge.html     合并页（队列拖动排序、混合队列黑屏段拼接、可拖入一个字幕文件）
html/clip.html      截取页（CSP 额外放行 media-src blob: file: 以播放本地文件）
html/crop.html      画面裁剪页（CSP 与 clip.html 相同；视频上叠 canvas 画框）
html/record.html    录屏页（CSP 同 clip.html 另放行 img-src data: 展示来源缩略图；
                    来源选择弹窗、声音勾选、实时预览、计时录制、结果一键转 MP4）
html/js/index.js    首页视图切换与清缓存逻辑
html/js/theme.js    全局主题：所有页面最先加载（须先于各页面脚本），监听
                    matchMedia('(prefers-color-scheme: dark)') 在 <html> 上设置
                    data-theme=light/dark（themeSource 变化与系统切换都会触发
                    change，覆盖 跟随系统/浅色/深色 三种状态）；并向每个页面
                    右上角注入主题切换按钮（跟随系统 → 浅色 → 深色 循环，
                    图标按 data-mode 显隐，经 ffgui:getTheme/setTheme 同步）
html/js/convert.js  转码页全部逻辑：候选格式/编码器清单是硬编码的，但会按主进程
                    探测到的真实能力过滤后填充下拉框；设备预设按 DEVICE_PRESETS
                    表锁定并填写兼容参数（切回自定义时恢复原设置，预设提示文案
                    与帧率标签随预设变化），纯音频格式自动隐藏视频
                    相关表单项，提交前校验分辨率与帧率格式（帧率可手填 1–240
                    的数字，留空保持源帧率）
html/js/merge.js    合并页全部逻辑：字幕单槽位拖放（拖到拼接队列区域的字幕文件会
                    自动转投字幕槽位），开始前校验字幕时长与合并总时长，
                    相差超过 10 秒才弹警告由用户确认（容差 ±10 秒内视为匹配）
html/js/clip.js     截取页全部逻辑：原生 <video> 播放（不引第三方播放器库，库不增加
                    解码能力），起止双滑块 + 步进寻址 + 抓帧截图；播放 error 时调
                    makePreview 生成预览副本兜底，失败则判定无法预览、禁止截取
html/js/crop.js     画面裁剪页全部逻辑：只接受 probeMedia 判定 hasVideo 的单文件；
                    <video> 暂停后点「绘制裁剪框」，用 Pointer Events 在视频实际
                    显示帧上拖拽画框（任意方向、边界钳制、框外压暗、过小判无效）；
                    canvas 按 object-fit: contain 的真实帧矩形定位（黑边不计入坐标），
                    随 devicePixelRatio 与窗口 resize 重绘，选框按归一化坐标保存故
                    不漂移；选框为相对画面的 {x, y, w, h}（0~1，x/y >= 0，w/h > 0，
                    x+w/y+h <= 1），界面只显示 X/Y/宽/高百分比（不做像素估算，
                    probe 的 coded 尺寸在旋转/SAR 非 1 时会误导）；
                    播放中禁止画框，切换文件或清除选框即重置并禁用开始；预览副本
                    只用于播放与画框，转换始终用原文件；提交 window.ffgui.convert
                    单输入 job（MP4/libx264/aac/yuv420p + quality + crop，保留全部
                    音轨，无设备预设/HDR/scale/sampleOnly），进度与取消复用
                    onConvertEvent / cancelConvert
html/js/record.js   录屏页全部逻辑：desktopCapturer 缩略图弹窗选来源 →
                    prepareDesktopSource 登记 → getDisplayMedia 被授予该来源
                    （系统声音为 'loopback' 回环音轨，仅 Windows）；记住 sourceId，
                    勾选系统声音后按原来源静默重新采集（失效才重开弹窗）；
                    系统声音与麦克风（getUserMedia）可选、双路混音走 AudioContext；
                    MediaRecorder 输出 WebM（vp9 优先，画质档映射
                    videoBitsPerSecond 8/4/2 Mbps），1s 分块串行写入主进程；
                    录制中 beforeunload 拦截离开页面
html/css/style.css  全部页面共用样式
bin/ffmpeg.exe      内置的 ffmpeg（Windows，full build 约 210MB）；放置规则见 bin/README.md：
bin/bin/ bin/lib/   macOS 为 bin/bin/ffmpeg + bin/lib/（自建预编译构建，来自
                    kisaragychihaya/ffmpeg_build_mac 的 release，混合静态构建：
                    大部分库静态编入，无 .a 静态库的依赖仍动态链接，经 dylibbundler
                    收集到 lib/，二进制引用 @executable_path/../lib，bin/ 与 lib/
                    相对布局不能变，只拷 ffmpeg 单文件无法运行）；打包时经
                    extraResource 复制到 resources/bin/（macOS）；Windows 只携带
                    ffmpeg.exe 单文件到 resources/ 根目录（ffprobe 未被应用使用，
                    不带；main/ffmpeg.js 的 getFfmpegPath 优先 resources/ffmpeg.exe，
                    兼容旧布局 resources/bin/ffmpeg.exe）；mac 未内置时回退 Homebrew
                    （官方源 ffmpeg 无 zimg，HDR 转 SDR 的 zscale 滤镜需要带 zimg
                    的构建，自建构建已含）；Linux 不携带 bin/，走系统 PATH
test_media/         手工测试用的示例音视频文件（不进入安装包）
_cdp_debug.js       开发调试脚本（CDP 连 Electron 渲染进程观察 video 加载状态，
                    依赖 ws（未列入 package.json，需另行 npm i ws），
                    属一次性调试工具，不参与正常运行）
forge.config.js     Electron Forge 配置（含压缩钩子与 Fuses）
makers/nsis.js      本地 Electron Forge maker：Windows 安装包（NSIS）适配层，
                    实际编译逻辑在 scripts/build-installer.cjs；
                    配置里必须 new 实例传入（Forge 凭 __isElectronForgeMaker 识别）
assets/installer.nsi NSIS 安装脚本：MUI2 现代界面（欢迎/许可证[须同意]/目录/安装/完成页），
                    LZMA 固实压缩 + 64MB 字典，每用户安装（%LOCALAPPDATA%\Programs，
                    无需管理员），桌面与开始菜单快捷方式「狒狒格式工具箱」+ 卸载入口，
                    写入 HKCU 卸载注册表项；安装与卸载均先 taskkill 结束运行中的
                    FFGui 进程（nsExec 静默执行），卸载对杀软临时占用重试一次；
                    中文产品名/路径由构建时生成的 UTF-8 BOM defines.nsh 注入
scripts/build-installer.cjs  编译安装包：调用 tools/nsisbi/makensis.exe；
                    也可独立运行 node scripts/build-installer.cjs --app-dir out/FFGui-win32-x64
                    [--arch arm64]（CI 即此用法）；脚本会先复制 installer.nsi 并补
                    UTF-8 BOM（makensis 把无 BOM 文件按 ANSI 解析）
tools/nsisbi/       NSISBI（NSIS 解除 2GB 限制分支）免安装 amd64 版的解压目标目录
                    （v3.12.2；来源与裁剪说明见 tools/nsisbi/README.md）。
                    二进制不入库：构建时由 build-installer.cjs 从 v0.1 Release 资源
                    nsisbi-3.12.2-amd64-trimmed.zip 下载解压（curl.exe + 系统 bsdtar，
                    注意 PATH 里 Git 的 GNU tar 不认 zip，必须用 System32 绝对路径），
                    目录内容被 .gitignore 忽略，删后下次构建自动重下
.github/workflows/  CI（见下文「部署 / CI」）
```

## 构建与运行命令

- `npm install` / `npm ci` — 安装依赖
- `npm start` — 开发运行（`electron-forge start`）
- `npm run package` — 打包到 `out/FFGui-win32-x64/`（packageAfterCopy 钩子会压缩 JS/HTML/CSS）
- `npm run make` — 生成安装包：Windows 为 NSIS 安装包 `FFGui-<版本>-<x64|arm64>-Setup.exe`
  （MUI2 现代界面 + 许可证页须同意 + 快捷方式「狒狒格式工具箱」，每用户安装无需管理员）

`npm test` 使用 Node 内置测试运行器（`scripts/regression.test.cjs`），需要 PATH 中有 ffmpeg/ffprobe，或设置 FFMPEG/FFPROBE。没有 lint/format 配置。

## 部署 / CI

`.github/workflows/build.yml`（workflow_dispatch 手动触发或发布 Release 时触发）：

- Windows x64 任务：从 GyanD/codexffmpeg 的 GitHub 最新 release 下载 full_build.7z（gyan.dev
  直链在 CI 上会被反爬拦截），取 `ffmpeg.exe` 放入 `bin/`，`npm ci` + `npm run package`，
  再经 `scripts/build-installer.cjs`（见上）生成 NSIS 安装包；`FFGui-windows-x64.7z` 与
  `FFGui-<版本>-x64-Setup.exe` 均上传 artifact；Release 触发时同时上传到 Release Assets
- Windows arm64 任务：从 tordona/ffmpeg-win-arm64 最新 release 下载 full-static-win-arm64.7z，
  同样取 `ffmpeg.exe` 放入 `bin/`；x64 runner 无法执行 arm64 二进制，改为校验 PE 头机器类型
  （0xAA64）；`npm run package -- --arch=arm64` 交叉打包（无原生依赖，可直接交叉），
  产物为 `FFGui-windows-arm64.7z` + `FFGui-<版本>-arm64-Setup.exe`（NSIS 安装器
  架构无关，由 x64 makensis 交叉编译 arm64 内容）
- macOS 任务：下载 kisaragychihaya/ffmpeg_build_mac 最新 release 的 macos-arm64-static
  tar.gz，`bin/` 与 `lib/` 原样放入项目 `bin/` 并 `chmod +x`，打包后用 ditto 压缩为
  `FFGui-macos-arm64.zip`；Release 触发时同样上传
- 仓库本身不提交 `bin/ffmpeg.exe` 等大文件，CI 每次现下；NSISBI 编译器同样不入库，
  由 build-installer.cjs 在构建时从 v0.1 Release 资源下载解压

## 代码约定

- 全部注释与界面文案使用简体中文，提交/文档同样使用中文
- 主进程/preload 为 CommonJS `require`；渲染进程脚本是无模块的 IIFE（HTML 有 CSP：
  `default-src 'self'; style-src 'self'; script-src 'self'`，禁止内联脚本与远程资源；
  clip.html、crop.html 与 record.html 额外放行 `media-src 'self' blob: file:`，
  record.html 另放行 `img-src 'self' data:`（来源缩略图））
- 渲染进程不得直接访问 Node API，一切跨进程能力走 `window.ffgui`（preload contextBridge）
- ffmpeg 的日志走 stderr、进度走 stdout（`-progress pipe:1`），主进程按行解析；
  新增转码功能时应复用 `main/ffmpeg.js` 中 `runFfmpegTask` 的 spawn/解析模式
- 输出文件名规则：与源文件同目录同格式时自动加 `_ffgui` 后缀避免覆盖源文件
  （`main/ffmpeg.js` 的 `buildOutputPath`）；合并输出固定为 `merged_<时间戳>.<格式>`；
  录屏输出固定为 `record_<时间戳>.webm`

## 安全注意事项

- 保持 `contextIsolation: true`、`nodeIntegration: false`；新增 IPC 时只在 preload 中暴露最小 API
- forge.config.js 中启用了 Electron Fuses（RunAsNode: false、OnlyLoadAppFromAsar: true、
  EnableEmbeddedAsarIntegrityValidation: true 等），不要为图方便关闭
- HTML 中的 CSP meta 不要放宽
- 打包后禁止打开 DevTools（index.js 中拦截 devtools-opened）

## 已知问题

- 应用图标已配置为 `assets/imgs/` 下的像素风胡萝卜（icon.png / icon.ico / icon.icns，
  命名必须与 `packagerConfig.icon` 一致，electron-packager 才能按平台自动选扩展名），
  由 `forge.config.js` 的 `packagerConfig.icon`、`index.js` 的窗口图标与各 HTML 的 favicon 引用
- 打包体积较大：`bin/ffmpeg.exe`（full build 约 140–210MB，视版本）经 extraResource
  原样分发且不进 asar，`packagerConfig.ignore` 中的 `/^\/bin($|\/)/` 规则不要删除，
  否则 asar 里会再塞一份。已做的精简：Windows 不携带应用未使用的 ffprobe（与
  ffmpeg 同体积）、packageAfterCopy 钩子裁剪 Electron 语言包（仅保留 zh-CN/en-US，
  省约 45MB）并删除仅 WebGPU 使用的 dxcompiler.dll/dxil.dll（省约 26MB），
  arm64 载荷约 420MB、安装包约 119MB；如仍嫌大可把 CI 的 ffmpeg 换成
  gyan.dev essentials 构建（能力有缩水，需评估）
  `extraResource` 按构建平台条件配置，Windows / macOS 携带 `bin/`，Linux 不携带
- forge.config.js 中不能出现 null 值（proxify 会崩溃），macOS 不签名靠省略 osxSign 实现
- `package.json` 中 `allowScripts` 字段是非 npm 标准字段（模板残留），当前无实际作用
- 录屏限制：系统声音走 'loopback' 回环，仅 Windows 支持（Electron 文档明确；
  macOS/Linux 无系统级回环，只能录麦克风）；MediaRecorder 画质只能控码率
  （无 CRF），帧率跟随屏幕；录屏与转码等任务沿用全局单任务假设（页面隔离保证不并发）

## 测试方式

自动化回归使用 `npm test`，生成独立临时媒体并自动清理。手工验证方式：`npm start` 启动应用，使用 `test_media/` 下的示例文件走一遍
转码流程（含拖拽添加、取消、进度显示），并在主进程控制台观察 `[ffgui]` / `[ffmpeg]` 日志；
录屏页验证录制（含系统声音 / 麦克风勾选、取消清理半成品、结果转 MP4）。

## 音轨与输出规则（修复后）

- `job.audioTrack` 留空保留全部音轨，否则为从 1 开始的音轨序号。MP3/FLAC/WAV/FLV 的多音轨输入须明确选轨。设备预设例外：留空取第 1 轨（映射 `0:a:0?`）。
- 纯音频输出默认 `-map_metadata 0` 保留文字标签、映射探测到的 attached pic 封面流（JPEG/PNG copy，其他转 mjpeg）；MP3 显式 `-id3v2_version`（默认 3）。封面只支持 MP3/M4A/FLAC，其余音频格式发 file-warning 不静默。
- `probeFile` 额外返回 `audioTracks`（按顺序排列的语言信息）。合并按序号逐轨 concat，缺轨补静音；每轨仍统一 44100 Hz stereo，界面明确提示规则。
- 转码显式映射视频、音频；MKV 同时映射字幕附件，其他转码容器不隐式带入附加流。截取使用 `-map 0 -c copy` 保留全部流。
- 输出路径避开全部输入、已有文件与本批目标，重名增加编号；转码/合并/截取使用 `-n`。不要改回无条件 `-y`。预览缓存与用户在保存对话框中选定的截图仍可覆盖。
- 进度字段跨 stdout 数据块保留，progress 事件携带 input；成功任务还必须收到 progress=end（部分 FFmpeg 构建拒绝覆盖也返回退出码 0）。
- 字幕路径分两层转义：先滤镜选项值，再滤镜图；调用方不再额外加单引号。
- 截取输入框保留毫秒，三个时间滑块步长为 0.001 秒。
