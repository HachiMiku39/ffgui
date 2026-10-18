# ffgui-disc

FFGui 的 DVD/BD 光盘抓取侧车进程。独立二进制，由 Electron 主进程
spawn，通过 stdin/stdout 的 NDJSON 协议对话。底层直接调用
[`freemkv-engine`](https://github.com/freemkv/freemkv-engine)（Rust 光盘抓取引擎），
**不解析任何 freemkv CLI 文本**。FFmpeg 后续负责转码，本进程只产出 MKV。

## 依赖与固定版本

四个上游 crate 均不在 crates.io 上，由本目录 `Cargo.toml` 的 `[patch.crates-io]`
固定到上游 tag `v1.8.4`。下表 commit 与 `Cargo.lock` 中
`source = "git+…?tag=v1.8.4#<rev>"` 逐字一致（**以 lockfile 为准**）：

| crate | Cargo.lock 中的 rev |
| --- | --- |
| `freemkv-engine` | `5585400af0a1ebbcb065c4fba834cae15186be9f` |
| `libfreemkv` | `2622b3fc5afe8eb4ebcd85f58eb0d498a3f6c743` |
| `freemkv-keysources` | `48f8906495530c27c3161253de51d21607a98856` |
| `freemkv-unlock` | `5a09422c6a8aba667879e569bddaf1f0624ed3c3` |

注意：任务书给的三个 rev（`38f8980c…` / `30f1da42…` / `dcda3da2…`）是 `v1.8.4`
的 **annotated tag 对象**，而 lockfile 记录的是它们指向的 **commit**。
`git rev-parse v1.8.4^{commit}` 可验证二者一致（tag 脱壳为 commit）。

上游 MSRV 为 Rust **1.88**（四个 crate 的 `rust-version` 均为 1.88）；本地用
1.97.1 验证通过，未升级全局工具链。

### 许可证与分发边界

上游四个 crate 自身均为 **MIT**，但 MIT 只覆盖上游自己的源码：

- `libfreemkv` 内含 `src/mux/codec/testdata/dist10/alloc_*`，是 ISO/IEC 11172-5
  参考软件（dist10）的位分配表，**不在 MIT 覆盖范围内**；版权归 ISO/IEC
  JTC1/SC29/WG11 与 ISO/MPEG Audio Subgroup Software Simulation Group，
  许可证为 `LicenseRef-ISO-dist10`（见上游 `LICENSES/LicenseRef-ISO-dist10.txt`
  与 `REUSE.toml` 的第三条注解）。它仅作测试数据用于校验 Layer II 解析器。
- `freemkv-unlock` 含厂商驱动器微码/固码补丁数据，各厂商条款不同；上游未在
  MIT 之外单独声明，但**不应把 "MIT" 当作覆盖这些厂商数据的依据**。

因此：FFGui 分发 `ffgui-disc` 二进制时，应按上游各自的 `LICENSES/` 与
`REUSE.toml` 一并提供，并在显著位置说明上述非 MIT 部分。本仓库**不复制任何
key、`profiles.json` 或微码数据**。

## 构建与测试

```bash
cd native/ffgui-disc
cargo build                 # 产物 target/debug/ffgui-disc(.exe)
cargo test --locked         # 单元 + 合成媒体验证 + 进程级 smoke
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
```

## 协议

一行一个 JSON 对象。stdin 接收请求，stdout **只**发事件，stderr 只发脱敏日志。
退出码 0 不代表成功——成功/失败一律以 `result` / `error` 事件表达。

### 请求

```json
{"version":1,"id":"job-1","method":"probe","params":{"source":{"kind":"iso|folder|drive","path":"..."}}}
{"version":1,"id":"job-1","method":"rip","params":{"source":{...},"titleId":"opaque","output":"...","audioTrackIds":null,"subtitleTrackIds":[],"keydbPath":null,"titleFingerprint":null}}
{"version":1,"id":"job-1","method":"list-drives","params":{}}
{"version":1,"id":"job-1","method":"cancel","params":{}}
```

- `source.kind`：`iso`（ISO 文件）、`folder`（已解密目录）、`drive`（物理驱动器）。
- `audioTrackIds` / `subtitleTrackIds`：字段缺失或 `null` = 保留该类全部轨；显式 `[]` =
  该类一条不保留；非空数组 = 只保留列出的轨，缺一即报 `FFGUI_TRACK_IDS`，绝不静默
  降级或丢轨。因此 `audioTrackIds:null` + `subtitleTrackIds:[]` 表示“全部音轨、无字幕”。
- `keydbPath`：可选本地 keydb，给出的路径必须存在。**在线密钥服务默认禁用**
  （不设 `key_url`），仓库中不复制任何 key 或 `profiles.json`。
- `titleFingerprint`：**可选**。填 probe 返回的 `fingerprint` 对象即启用跨调用
  内容校验（详见下文）；省略或 `null` 则只按 `titleId` 定位。
- `cancel` 可与 job 同 id 随时到达，中断进行中的抓取。stdin 由独立线程读取，
  因此 job 运行期间发出的 cancel 会立即置位共享 `Halt`/`Sink` 标志。
- 一个侧车进程只处理一个初始请求：终态（`result` / `error`）之后进程自行以退出码 0
  退出，调用方以退出码收尾。协议错误（坏 JSON、错版本、未知 method）不会终止进程，
  后续行继续被处理。

### 事件

```json
{"version":1,"id":"job-1","type":"progress","phase":"scan|rip","bytesDone":0,"bytesTotal":0,"speedBps":null,"etaSecs":null,"pass":"mux"}
{"version":1,"id":"job-1","type":"log","level":"info|warning|error","code":"...","params":{}}
{"version":1,"id":"job-1","type":"result","result":{...}}
{"version":1,"id":"job-1","type":"error","error":{"code":"E...","params":{}}}
```

- `probe` 的 `result`：`{disc:{format,label,titles:[...],encrypted}}`；
  title 含 `id,durationMs,sizeBytes,chapters,video,audio,subtitles,fingerprint`；
  stream 含 `id,codec,language,label`，未知语言为 `null`。
- `progress` 的 `pass` 是上游引擎原始 pass 名（`mux`/`sync`/`verify`/`sweep`/…），
  与 `phase`（`scan`/`rip`，兼容既有前端）并存。
- `rip` 的 `result`：`{output,titleId}`。
- `list-drives` 的 `result`：`{drives:[{kind:"drive",path,label}]}`。上游不支持设备发现的
  平台返回 `FFGUI_UNSUPPORTED`，`params` 含 `feature/platform/reason`；不会用空数组冒充
  “支持但没有光驱”。
- 引擎错误码原样字符串化（`E7022`、`E9064` 等）；协议/参数错误用 `FFGUI_*` 前缀。

### titleId 与轨道 id

`DiscTitle` 没有跨会话稳定的 id，`disc.titles` 的顺序也可能随扫描证据重排，
所以**不能把数组下标当 id**：

- `titleId` = `<format>/<playlist>`（BD 的 `00000.mpls`、DVD 的 `VTS_01_1.VOB`），
  同一持久标识出现多条时追加 `#<序号>`（按 extents 首 LBA 排序后确定）。
  该标识来自盘自身结构，与数组位置无关，因此重排、扫描证据变化都不改 id。
- rip 时**重新扫描**，按 `titleId` 在新扫描结果里定位标题。
- 轨道 id = `s<streams 下标>:p<PID>:<语言|und>`，probe 与 rip 用同一构造，
  rip 侧逐条回比，不匹配即报 `FFGUI_TRACK_IDS`。

### 物理驱动器路径

- 设备发现直接调用上游 `libfreemkv::list_drives()`，支持 Windows / Linux / macOS，
  侧车不另写一套 sysfs、IOKit 或 SetupAPI 实现。
- drive probe 使用 `open_scan_with` / `DiscSession` 做真实 SCSI 打开、bring-up、扫描和
  托盘锁；drive rip 也重新开驱扫描，再按 `titleId` 与可选 `titleFingerprint` 定位。
- rip 将本次 session 的 drive stage 为 reader，只针对所选标题解析
  `KeyScope::Titles(vec![probed])`，再把该 reader 和扫描标题交给上游 `run_with`。
  不会通过 `disc://` 二次打开设备，也不需要 stage 中间 ISO，因此没有 ISO 临时文件清理
  分支；输出仍遵守 `.ffgui-partial` 防覆盖与所有终态清理规则。
- 开驱、密钥解析和 mux 使用同一个 `Halt`；mux 由上游 `run_with` 同时桥接 `Halt` 与
  `Sink::should_cancel`，进度、速度和 ETA 也来自上游 watcher。

### 内容指纹（可选，`titleFingerprint`）

probe 的每个 title 额外带一个 `fingerprint` 对象：
`{id, firstLba, sectors, durationSecs, sizeBytes}`。前端可在 rip 时通过
**可选的** `titleFingerprint` 字段把它带回，rip 会拿它与重新扫描的结果逐一
比对，不一致报 `FFGUI_TITLE_MISMATCH`。

- 这是**唯一真正生效**的"盘没被换掉"校验：它跨进程比对一个独立来源的期望值。
- 不带该字段时只按 `titleId` 定位，不做内容校验（兼容既有调用方）。
- 之前版本曾声称"rip 重扫后比对指纹"，但期望值来自同一次扫描、与实测值恒等，
  实际不提供任何保护——已删掉那段虚假宣传。现在的实现要么真的比对外部期望值，
  要么明确说明不比对。
- 协议未破坏：`titleFingerprint` 是纯新增可选字段，老请求照旧工作。

## 支持边界与验证状态

| 能力 | 状态 |
| --- | --- |
| ISO probe + 单标题无损 MKV rip | 支持，有合成媒体端到端测试 |
| 已解密目录（folder）probe + rip | 支持（与 iso 同路径，有端到端测试） |
| 物理驱动器（drive）probe + rip | 已接真实上游 API；Windows / Linux / macOS；**未真机验证** |
| 光驱发现（list-drives） | 上游 Windows / Linux / macOS 实现；其他平台返回 `FFGUI_UNSUPPORTED` |
| 多标题批量 rip | 不支持（每次一个标题） |
| 在线密钥服务 | 默认禁用；可选本地 `keydbPath`（路径必须存在） |
| 输出覆盖 | 不覆盖；写 `.ffgui-partial`，成功后 `no_replace` 原子发布 |
| 预存 `.ffgui-partial` | 拒绝（`FFGUI_PARTIAL_EXISTS`），且绝不被清理 |
| 取消 | 独立 stdin 线程即时置位共享 `Halt` + `Sink::should_cancel`，中断扫描/开镜像/抓取 |
| 内容指纹校验 | 可选 `titleFingerprint`；不带则只按 titleId 定位 |
| 进度 / 速度 / ETA | 全部来自 engine `Sink`，侧车不重算；`pass` 原样附带上游名 |

### 未真机验证边界

本机没有物理光驱。drive probe / rip 目前只通过了编译、单元测试以及 ISO/folder 合成媒体
回归；**没有在真实 DVD/BD 驱动器上验证过**打开、扫描、托盘锁、密钥解析、实际抓取或
中途取消。`list-drives` 只验证了本机枚举与协议形状，不能替代插盘测试。后续在真实硬件
验证前，不应把这些路径描述为已经实物验收。

## 目录结构

```
src/main.rs     进程入口：独立 stdin 读取线程、job 分发、worker 线程
src/protocol.rs NDJSON 编解码
src/model.rs    DiscTitle → 协议视图、titleId / 轨道 id / 内容指纹
src/jobs.rs     probe / rip / list-drives 实现
src/sink.rs     engine Sink → NDJSON 事件（含脱敏）
src/source.rs   iso / folder / drive 源校验
src/cancel.rs   取消标志登记
tests/          协议、模型、源校验、合成媒体验证、进程级 smoke
```
