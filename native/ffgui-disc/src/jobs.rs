//! probe / rip / list-drives 三个方法的实现。

use crate::errors;
use crate::model::{self, TitleIdentity, TrackChoice};
use crate::sink::NdjsonSink;
use crate::source::{DiscSource, SourceKind};
use freemkv_engine::{
    Disc, Held, ImageSource, KeyInput, KeyParams, MuxPlan, OpenImageOptions, OpenedImage, Plan,
    Report, RipOutcome, RunWith, Selection, Sink, TitleOptions, key_source_factory,
    mux_image_titles_with, open_image_with, run_with, scan_image,
};
use libfreemkv::{Halt, PidFilter, StreamSelection, keys::KeyScope};
use serde_json::{Map, Value};

/// 探测一个光盘源：扫描并返回标题/流清单。
pub fn probe(
    sink: &NdjsonSink,
    source: &DiscSource,
) -> Result<Value, (String, Map<String, Value>)> {
    if matches!(source.kind, SourceKind::Drive(_)) && !platform_covered() {
        return Err(platform_unsupported("drive"));
    }
    let (disc, _reader) = match scan(source, sink) {
        Ok(v) => v,
        Err(e) => return Err(engine_error(sink, e)),
    };
    let mut outer = Map::new();
    outer.insert("disc".into(), disc_view(&disc));
    Ok(Value::Object(outer))
}

pub fn disc_view(disc: &Disc) -> Value {
    let identities = model::title_identities(disc);
    let titles: Vec<Value> = disc
        .titles
        .iter()
        .zip(identities.iter())
        .map(|(title, id)| title_view(title, id))
        .collect();
    let mut m = Map::new();
    m.insert(
        "format".into(),
        Value::String(model::format_id(disc.format).to_string()),
    );
    m.insert(
        "label".into(),
        Value::String(
            disc.meta_title
                .clone()
                .unwrap_or_else(|| disc.volume_id.clone()),
        ),
    );
    m.insert("titles".into(), Value::Array(titles));
    m.insert("encrypted".into(), Value::Bool(disc.encrypted));
    Value::Object(m)
}

fn title_view(title: &freemkv_engine::DiscTitle, id: &TitleIdentity) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), Value::String(id.stable_id.clone()));
    m.insert("durationMs".into(), Value::from(ms_of(title.duration_secs)));
    m.insert("sizeBytes".into(), Value::from(title.size_bytes));
    m.insert("chapters".into(), Value::from(title.chapters.len()));
    // 内容指纹：前端可在 rip 时通过可选的 `titleFingerprint` 字段带回，
    // 让 rip 真正校验"盘的这一个标题没变过"。缺省不带该字段 = 不校验。
    m.insert("fingerprint".into(), Value::Object(fingerprint_view(id)));
    let mut video: Vec<Value> = Vec::new();
    let mut audio: Vec<Value> = Vec::new();
    let mut subtitles: Vec<Value> = Vec::new();
    for (index, stream) in title.streams.iter().enumerate() {
        let (kind, view) = model::stream_view(stream, index);
        match kind.as_str() {
            "video" => video.push(view),
            "audio" => audio.push(view),
            "subtitle" => subtitles.push(view),
            _ => {}
        }
    }
    m.insert("video".into(), Value::Array(video));
    m.insert("audio".into(), Value::Array(audio));
    m.insert("subtitles".into(), Value::Array(subtitles));
    Value::Object(m)
}

fn ms_of(secs: f64) -> u64 {
    if !secs.is_finite() || secs <= 0.0 {
        0
    } else {
        (secs * 1000.0).round() as u64
    }
}

/// 标题内容指纹的协议视图。字段名与 `model::parse_fingerprint` 的读取一一对应。
fn fingerprint_view(id: &TitleIdentity) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("id".into(), Value::String(id.stable_id.clone()));
    match id.first_lba {
        Some(lba) => m.insert("firstLba".into(), Value::from(lba)),
        None => m.insert("firstLba".into(), Value::Null),
    };
    m.insert("sectors".into(), Value::from(id.sectors));
    m.insert("durationSecs".into(), Value::from(id.duration_secs));
    m.insert("sizeBytes".into(), Value::from(id.size_bytes));
    m
}

/// 扫描一个源，返回 disc 与 reader。
///
/// - `iso` / `folder`：走引擎的 `scan_image`。
/// - `drive`：走上游 `open_scan_with`（真实 SCSI 打开 + bring-up + 扫描 + 锁托盘），
///   再把 drive stage 成 reader。取消经 `halt` 传入，扫描中可中断。
pub fn scan(
    source: &DiscSource,
    sink: &NdjsonSink,
) -> Result<(Disc, Box<dyn libfreemkv::SectorSource>), libfreemkv::Error> {
    match &source.kind {
        SourceKind::Iso(path) | SourceKind::Folder(path) => {
            scan_image(&ImageSource::from_path(path))
        }
        SourceKind::Drive(path) => scan_drive(path, sink),
    }
}

/// drive 源的设备目标：协议里给了路径就用 `Path`，空路径用 `Autodetect`。
fn device_target(path: &std::path::Path) -> libfreemkv::DeviceTarget {
    if path.as_os_str().is_empty() {
        libfreemkv::DeviceTarget::Autodetect
    } else {
        libfreemkv::DeviceTarget::Path(path.to_path_buf())
    }
}

/// 打开并扫描物理光驱。使用上游 `freemkv_engine::open_scan_with`：
/// `DiscSession::open_with`（SCSI 打开 + wait_ready/init  advisory bring-up）→
/// `scan_with`（真实盘结构解析）→ `lock_tray`（防中途弹盘）。
///
/// 之后 `stage_drive_as_reader` + `take_reader` 把 drive 变成 reader，
/// 与 iso/folder 的 reader 类型一致，供后续 mux 使用。
pub fn scan_drive(
    path: &std::path::Path,
    sink: &NdjsonSink,
) -> Result<(Disc, Box<dyn libfreemkv::SectorSource>), libfreemkv::Error> {
    // Halt 与 Sink::should_cancel 读取同一个登记标志；open_scan_with 轮询这个 Halt。
    let halt = Halt::from_arc(crate::cancel::flag_for(sink.job_id()));
    if crate::cancel::is_cancelled(sink.job_id()) {
        halt.cancel();
    }
    let progress = libfreemkv::halt::Liveness::new();
    // raw_copy = false：需要解密内容（AACS/CSS），不是裸拷贝。
    let mut session =
        freemkv_engine::open_scan_with(device_target(path), None, false, &halt, &progress)?;
    let disc = session.take_disc().ok_or(libfreemkv::Error::NoStreams)?;
    session.stage_drive_as_reader();
    let reader = session
        .take_reader()
        .ok_or_else(|| libfreemkv::Error::DeviceNotReady {
            path: session.device_path().to_string(),
        })?;
    Ok((disc, reader))
}

/// 枚举本机光驱。使用上游 `libfreemkv::list_drives()`（每平台 sysfs / IOKit /
/// SetupAPI 遍历 + 一次 INQUIRY），不自己做平台实现。
///
/// 上游未覆盖的平台必须返回结构化 unsupported，不能把空数组伪装成"没有光驱"。
pub fn list_drives() -> Result<Value, (String, Map<String, Value>)> {
    if !platform_covered() {
        return Err(platform_unsupported("list-drives"));
    }
    let drives: Vec<Value> = libfreemkv::list_drives()
        .into_iter()
        .map(|d| {
            let mut m = Map::new();
            m.insert("kind".into(), Value::String("drive".into()));
            m.insert("path".into(), Value::String(d.path));
            let mut label = d.display_name;
            if !d.model.trim().is_empty() {
                label = if label.is_empty() {
                    d.model.trim().to_string()
                } else {
                    format!("{label} ({})", d.model.trim())
                };
            }
            m.insert("label".into(), Value::String(label));
            Value::Object(m)
        })
        .collect();
    let mut m = Map::new();
    m.insert("drives".into(), Value::Array(drives));
    Ok(Value::Object(m))
}

/// 上游设备发现与 DiscSession 有实际实现的平台。
fn platform_covered() -> bool {
    cfg!(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    ))
}

fn platform_unsupported(feature: &str) -> (String, Map<String, Value>) {
    (
        errors::ERR_UNSUPPORTED.to_string(),
        errors::params(&[
            ("feature", Value::String(feature.to_string())),
            ("platform", Value::String(std::env::consts::OS.to_string())),
            (
                "reason",
                Value::String("upstream drive backend does not cover this platform".into()),
            ),
        ]),
    )
}

/// 抓取单个标题到 MKV。重新扫描并按 titleId 定位；调用方若通过
/// `title_fingerprint` 带了 probe 阶段的指纹，则真正跨调用校验盘的这一个标题
/// 没被换掉，不一致即报 `FFGUI_TITLE_MISMATCH`，绝不静默改抓别的标题。
///
/// `audio` / `subtitle` 是三态选轨（见 [`TrackChoice`]）：缺失或 null = 全部，
/// 显式 `[]` = 一条不保留，非空 = 只保留列出的轨。
#[allow(clippy::too_many_arguments)]
pub fn rip(
    sink: &NdjsonSink,
    source: &DiscSource,
    title_id: &str,
    output: &std::path::Path,
    audio: &TrackChoice,
    subtitle: &TrackChoice,
    keydb_path: Option<&std::path::Path>,
    title_fingerprint: Option<&serde_json::Value>,
) -> Result<Value, (String, Map<String, Value>)> {
    if matches!(source.kind, SourceKind::Drive(_)) && !platform_covered() {
        return Err(platform_unsupported("drive"));
    }
    if output.exists() {
        return Err((
            errors::ERR_OUTPUT_EXISTS.to_string(),
            errors::params(&[("path", Value::String(output.display().to_string()))]),
        ));
    }
    let partial = partial_path(output);
    // 半成品路径若已被用户预先占用，直接拒绝：后续清理只动本次创建的 partial，
    // 绝不能删掉一个恰好同名的既有文件。
    if partial.exists() {
        return Err((
            errors::ERR_PARTIAL_EXISTS.to_string(),
            errors::params(&[("path", Value::String(partial.display().to_string()))]),
        ));
    }

    let key_params = KeyParams {
        keydb_path: keydb_path.map(|p| p.display().to_string()),
        ..Default::default()
    };
    let sources = key_source_factory(&key_params);

    // 取消经两条路进入：Sink::should_cancel（引擎每轮询一次）与这里的 Halt 标志
    // （stdin 的 cancel 请求置位，扫描/开镜像/抓取都能看到）。
    let halt = Halt::from_arc(crate::cancel::flag_for(sink.job_id()));
    if crate::cancel::is_cancelled(sink.job_id()) {
        halt.cancel();
    }

    match &source.kind {
        // 物理盘：开驱扫描后由 drive reader 直接 mux，无需 stage 中间 ISO。
        SourceKind::Drive(path) => rip_from_drive(
            sink,
            path,
            title_id,
            output,
            &partial,
            audio,
            subtitle,
            &key_params,
            &sources,
            &halt,
            title_fingerprint,
        ),
        // 镜像/目录：开镜像取密钥集，再从镜像 mux。
        SourceKind::Iso(_) | SourceKind::Folder(_) => rip_from_image(
            sink,
            source,
            title_id,
            output,
            &partial,
            audio,
            subtitle,
            &key_params,
            sources,
            &halt,
            title_fingerprint,
        ),
    }
}

/// 镜像/目录源的抓取路径：`open_image_with` 取密钥集 → `mux_image_titles_with`。
#[allow(clippy::too_many_arguments)]
fn rip_from_image(
    sink: &NdjsonSink,
    source: &DiscSource,
    title_id: &str,
    output: &std::path::Path,
    partial: &std::path::Path,
    audio: &TrackChoice,
    subtitle: &TrackChoice,
    _key_params: &KeyParams,
    sources: libfreemkv::KeySourceFactory,
    halt: &Halt,
    title_fingerprint: Option<&serde_json::Value>,
) -> Result<Value, (String, Map<String, Value>)> {
    let image = ImageSource::from_path(source.path());
    // 重新扫描（probe 与 rip 之间盘可能被换掉），按 titleId 定位。
    let (disc, _reader) = match scan_image(&image) {
        Ok(v) => v,
        Err(e) => return Err(engine_error(sink, e)),
    };
    let expected = model::parse_fingerprint(title_fingerprint);
    let probed = match model::find_title(&disc, title_id, expected.as_ref()) {
        Ok(idx) => idx,
        Err(lookup) => return Err(title_lookup_error(lookup)),
    };

    let opts = OpenImageOptions {
        // 显式把密钥 scope 指向用户实际选择的标题。上游 `OpenImageOptions.scope`
        // 缺省是 `KeyScope::Titles(main_scope(disc))`，即固定 title 0；非首标题
        // 会因此拿到不覆盖自己的 key set 而误报 E7022。
        keys: KeyInput::Resolve(sources.clone()),
        scope: Some(KeyScope::Titles(vec![probed])),
        halt: Some(halt.clone()),
        ..OpenImageOptions::resolve(sources)
    };
    let opened: OpenedImage = match open_image_with(&image, opts) {
        Ok(o) => o,
        Err(e) => return Err(engine_error(sink, e)),
    };

    let selection = build_selection(&disc.titles[probed], audio, subtitle)?;

    let plan = MuxPlan {
        titles: vec![probed],
        explicit_selection: true,
        streams: vec![(probed, selection)],
        mux: freemkv_engine::mux_options(false),
    };
    let dest_url = format!("mkv://{}", partial.display());
    let outcome = mux_image_titles_with(&opened, &plan, &|_| dest_url.clone(), sink, halt);
    finish_rip(sink, output, partial, title_id, outcome)
}

/// 物理盘的抓取路径：`open_scan_with` 开驱扫描 → 按 titleId 定位 →
/// 把本次扫描得到的 reader 与标题交给上游 `run_with`，由 `Source::from_reader`
/// 直接 mux，不重新打开设备，也不需要 stage 中间 ISO。
///
/// 密钥只解析选定标题的 scope（`KeyScope::Titles(vec![probed])`），与镜像路径一致。
/// `run_with` 同时接收共享 Halt 与 Sink，取消、进度、速度和 ETA 都走上游 watcher。
#[allow(clippy::too_many_arguments)]
fn rip_from_drive(
    sink: &NdjsonSink,
    device: &std::path::Path,
    title_id: &str,
    output: &std::path::Path,
    partial: &std::path::Path,
    audio: &TrackChoice,
    subtitle: &TrackChoice,
    _key_params: &KeyParams,
    sources: &libfreemkv::KeySourceFactory,
    halt: &Halt,
    title_fingerprint: Option<&serde_json::Value>,
) -> Result<Value, (String, Map<String, Value>)> {
    let progress = libfreemkv::halt::Liveness::new();
    let mut session =
        match freemkv_engine::open_scan_with(device_target(device), None, false, halt, &progress) {
            Ok(s) => s,
            Err(e) => return Err(engine_error(sink, e)),
        };
    let device_name = session.device_path().to_string();
    let batch_sectors = libfreemkv::disc::detect_max_batch_sectors(&device_name);
    let disc = match session.take_disc() {
        Some(d) => d,
        None => return Err(engine_error(sink, libfreemkv::Error::NoStreams)),
    };

    let expected = model::parse_fingerprint(title_fingerprint);
    let probed = match model::find_title(&disc, title_id, expected.as_ref()) {
        Ok(idx) => idx,
        Err(lookup) => return Err(title_lookup_error(lookup)),
    };
    let selection = build_selection(&disc.titles[probed], audio, subtitle)?;

    session.stage_drive_as_reader();
    let mut reader = match session.take_reader() {
        Some(r) => r,
        None => {
            return Err(engine_error(
                sink,
                libfreemkv::Error::DeviceNotReady { path: device_name },
            ));
        }
    };
    let keys = match freemkv_engine::keys::resolve_for_rip(
        &disc,
        reader.as_mut(),
        KeyScope::Titles(vec![probed]),
        sources,
        None,
        Some(halt),
    ) {
        Ok(k) => k,
        Err(e) => return Err(engine_error(sink, e)),
    };
    let scanned = match libfreemkv::ScannedTitle::of(&disc, probed) {
        Some(s) => s,
        None => {
            return Err(engine_error(
                sink,
                libfreemkv::Error::DiscTitleRange {
                    index: probed,
                    count: disc.titles.len(),
                },
            ));
        }
    };

    let plan = Plan {
        source: format!("disc://{device_name}"),
        dest: format!("mkv://{}", partial.display()),
        titles: Selection::Titles(vec![0]),
        raw: false,
        multipass: false,
        force: false,
        ..Default::default()
    };
    let with = RunWith {
        keys: Some(keys),
        held: Some(Held::Title {
            reader,
            title: Box::new(scanned),
        }),
        title: TitleOptions {
            selection: Some(selection),
            skip_errors: false,
            batch_sectors,
        },
        halt: Some(halt.clone()),
        ..Default::default()
    };
    let outcome = run_with(&plan, with, sink)
        .map_err(std::io::Error::from)
        .and_then(|report| match report {
            Report::Title { outcome } => Ok(outcome),
            _ => Err(std::io::Error::other("unexpected non-title engine report")),
        });
    finish_rip_drive(sink, output, partial, title_id, outcome)
}

/// 镜像路径的收尾：发布 / 清理 partial。
fn finish_rip(
    sink: &NdjsonSink,
    output: &std::path::Path,
    partial: &std::path::Path,
    title_id: &str,
    outcome: RipOutcome,
) -> Result<Value, (String, Map<String, Value>)> {
    let mut ours = OwnedPartial::new(partial.to_path_buf());
    match outcome {
        RipOutcome::Ok { titles_written } if titles_written > 0 => {
            if let Err(e) = publish(partial, output) {
                ours.remove();
                return Err(engine_error(sink, e));
            }
            ours.disarm();
            let mut m = Map::new();
            m.insert("output".into(), Value::String(output.display().to_string()));
            m.insert("titleId".into(), Value::String(title_id.to_string()));
            Ok(Value::Object(m))
        }
        RipOutcome::Ok { .. } => {
            ours.remove();
            Err(unsupported("rip", "no titles were written"))
        }
        RipOutcome::NoKey => {
            ours.remove();
            Err((
                format!("E{}", libfreemkv::error::E_NO_DISC_KEY),
                errors::params(&[(
                    "reason",
                    Value::String("engine reported a disc-level no-key outcome".into()),
                )]),
            ))
        }
        RipOutcome::Failed {
            title_index,
            code,
            data,
            ..
        } => {
            ours.remove();
            let code = code
                .map(|c| format!("E{c}"))
                .unwrap_or_else(|| errors::ERR_INTERNAL.to_string());
            let mut params = Map::new();
            params.insert("titleIndex".into(), Value::from(title_index));
            params.insert("reason".into(), Value::String(crate::sink::sanitize(&data)));
            Err((code, params))
        }
        RipOutcome::Halted => {
            ours.remove();
            Err((errors::ERR_CANCELLED.to_string(), Map::new()))
        }
    }
}

/// drive 路径的收尾：mux 返回 `io::Result<MuxOutcome>`，先判 halt 再发布。
fn finish_rip_drive(
    sink: &NdjsonSink,
    output: &std::path::Path,
    partial: &std::path::Path,
    title_id: &str,
    outcome: std::io::Result<libfreemkv::MuxOutcome>,
) -> Result<Value, (String, Map<String, Value>)> {
    let mut ours = OwnedPartial::new(partial.to_path_buf());
    match outcome {
        Ok(m) if m.completed => {
            if let Err(e) = publish(partial, output) {
                ours.remove();
                return Err(engine_error(sink, e));
            }
            ours.disarm();
            let mut out = Map::new();
            out.insert("output".into(), Value::String(output.display().to_string()));
            out.insert("titleId".into(), Value::String(title_id.to_string()));
            Ok(Value::Object(out))
        }
        Ok(m) if m.halted => {
            ours.remove();
            Err((errors::ERR_CANCELLED.to_string(), Map::new()))
        }
        Ok(m) => {
            ours.remove();
            let mut params = Map::new();
            params.insert("reason".into(), Value::String("mux incomplete".into()));
            params.insert("bytesWritten".into(), Value::from(m.bytes_written));
            Err((errors::ERR_INTERNAL.to_string(), params))
        }
        Err(e) => {
            ours.remove();
            if libfreemkv::is_halt(&e) {
                return Err((errors::ERR_CANCELLED.to_string(), Map::new()));
            }
            let code = freemkv_engine::error_code(&e)
                .map(|c| format!("E{c}"))
                .unwrap_or_else(|| errors::ERR_INTERNAL.to_string());
            let mut params = Map::new();
            params.insert(
                "reason".into(),
                Value::String(crate::sink::sanitize(&format!("{e:?}"))),
            );
            Err((code, params))
        }
    }
}
/// 本次 rip 创建的半成品文件。只删自己创建的那个：`disarm` 之后不再删，
/// 因此发布成功后不会误删，路径被替换过时也按"本次创建"语义处理。
struct OwnedPartial {
    path: Option<std::path::PathBuf>,
}

impl OwnedPartial {
    fn new(path: std::path::PathBuf) -> Self {
        OwnedPartial { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }

    fn remove(&mut self) {
        if let Some(p) = self.path.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// 抓取过程的中间文件名：`<output>.ffgui-partial`。
pub fn partial_path(output: &std::path::Path) -> std::path::PathBuf {
    let mut name = output.file_name().unwrap_or_default().to_os_string();
    name.push(".ffgui-partial");
    output.with_file_name(name)
}

/// 发布半成品：仅当目标不存在时落地（不覆盖已有文件）。
fn publish(partial: &std::path::Path, target: &std::path::Path) -> Result<(), libfreemkv::Error> {
    libfreemkv::io::publish::no_replace(partial, target).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => libfreemkv::Error::RemuxTargetExists {
            path: target.display().to_string(),
        },
        _ => libfreemkv::Error::from(e),
    })
}

fn title_lookup_error(lookup: model::TitleLookup) -> (String, Map<String, Value>) {
    match lookup {
        model::TitleLookup::Unknown => (errors::ERR_TITLE_UNKNOWN.to_string(), Map::new()),
        model::TitleLookup::Mismatch { expected, found } => (
            errors::ERR_TITLE_MISMATCH.to_string(),
            errors::params(&[
                ("expected", Value::String(expected)),
                ("found", Value::String(found)),
            ]),
        ),
    }
}

/// 三态选轨 → `libfreemkv::StreamSelection`（PID 过滤）。
///
/// - `All` → `PidFilter::All`（保留该类全部轨）
/// - `None` → `PidFilter::Only(vec![])`（一条不保留）
/// - `Only(ids)` → `PidFilter::Only(pids)`，逐条回比，缺一即报 `FFGUI_TRACK_IDS`
///
/// 两者皆 `All` 时返回 default（`is_all()` 为真，mux 走无选轨路径）。
fn build_selection(
    title: &freemkv_engine::DiscTitle,
    audio: &TrackChoice,
    subtitle: &TrackChoice,
) -> Result<StreamSelection, (String, Map<String, Value>)> {
    if *audio == TrackChoice::All && *subtitle == TrackChoice::All {
        return Ok(StreamSelection::default());
    }
    Ok(StreamSelection {
        audio: pids_for(title, audio, "audio")?,
        subtitle: pids_for(title, subtitle, "subtitle")?,
    })
}

fn pids_for(
    title: &freemkv_engine::DiscTitle,
    choice: &TrackChoice,
    class: &str,
) -> Result<PidFilter, (String, Map<String, Value>)> {
    match choice {
        TrackChoice::All => Ok(PidFilter::All),
        TrackChoice::None => Ok(PidFilter::Only(Vec::new())),
        TrackChoice::Only(ids) => {
            let mut pids = Vec::with_capacity(ids.len());
            for want in ids {
                let raw = want.encode();
                let stream = title
                    .streams
                    .get(want.index)
                    .ok_or_else(|| track_id_error(&raw, class, None))?;
                let actual = model::stream_id_of(stream, want.index);
                if actual != raw {
                    return Err(track_id_error(&raw, class, Some(&actual)));
                }
                let class_ok = match class {
                    "audio" => matches!(stream, freemkv_engine::Stream::Audio(_)),
                    "subtitle" => matches!(stream, freemkv_engine::Stream::Subtitle(_)),
                    _ => false,
                };
                if !class_ok {
                    return Err(track_id_error(&raw, class, None));
                }
                pids.push(want.pid);
            }
            Ok(PidFilter::Only(pids))
        }
    }
}

fn track_id_error(raw: &str, class: &str, actual: Option<&str>) -> (String, Map<String, Value>) {
    let mut pairs = vec![
        ("id", Value::String(raw.to_string())),
        ("class", Value::String(class.to_string())),
    ];
    if let Some(a) = actual {
        pairs.push(("actual", Value::String(a.to_string())));
    }
    (errors::ERR_TRACK_IDS.to_string(), errors::params(&pairs))
}

fn engine_error(sink: &NdjsonSink, e: libfreemkv::Error) -> (String, Map<String, Value>) {
    sink.log(
        freemkv_engine::Level::Error,
        &format!("engine refused: {e}"),
    );
    (format!("E{}", e.code()), Map::new())
}

fn unsupported(what: &str, why: &str) -> (String, Map<String, Value>) {
    (
        errors::ERR_UNSUPPORTED.to_string(),
        errors::params(&[
            ("feature", Value::String(what.to_string())),
            ("reason", Value::String(why.to_string())),
        ]),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_platform_error_is_machine_readable() {
        let (code, params) = platform_unsupported("list-drives");
        assert_eq!(code, errors::ERR_UNSUPPORTED);
        assert_eq!(params["feature"], "list-drives");
        assert_eq!(params["platform"], std::env::consts::OS);
        assert!(params["reason"].is_string());
    }

    #[test]
    fn drive_cancel_cleans_partial_without_publishing() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("movie.mkv");
        let partial = partial_path(&output);
        std::fs::write(&partial, b"incomplete").unwrap();
        let sink = NdjsonSink::new("drive-cancel-test");

        let err = finish_rip_drive(
            &sink,
            &output,
            &partial,
            "bluray/00000.mpls",
            Err(libfreemkv::Error::Halted.into()),
        )
        .unwrap_err();

        assert_eq!(err.0, errors::ERR_CANCELLED);
        assert!(!partial.exists(), "取消后不得留下本次半成品");
        assert!(!output.exists(), "取消后不得发布输出");
    }
}
