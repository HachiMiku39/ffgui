//! 光盘模型映射与稳定标识。
//!
//! `DiscTitle` 没有跨会话稳定的 id：DVD 用 `VTS_nn_n.VOB`（playlist 字段），
//! Blu-ray/UHD 用 `nnnnn.mpls`（playlist 字段 + playlist_id）。排序后的
//! `disc.titles` 会因扫描证据变化而重排，所以不能把数组下标当 id。
//!
//! titleId 采用「持久标识 + 内容指纹」：
//!   持久标识 = `<format>/<playlist>`（DVD 另有 playlist_id）
//!   内容指纹 = 该标题的 extents 派生（首 LBA + 总扇区 + 扇区数），
//!             与时长、大小一起用于 rip 时重新扫描后的校验。
//! 出现同持久标识的多条记录时追加 `#<序号>` 消歧（同盘多个 PGC 映射到
//! 同一 VTS 名的情形），序号按 extents 首 LBA 排序后确定，保持稳定。

use freemkv_engine::{Codec, Disc, DiscFormat, DiscTitle, Resolution, Stream};
use serde_json::{Map, Value};

/// 一条音轨/字幕轨的结构化标识：probe 与 rip 使用同一构造，
/// 所以 rip 侧拿到的 id 必须能在重新扫描后的标题里找到同一条流。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackId {
    /// 流在标题 `streams` 中的声明序号（从 0 开始）。
    pub index: usize,
    /// MPEG-TS PID；DVD 程序流为 0。
    pub pid: u16,
    /// ISO 639-2 语言码，未知为 None。
    pub language: Option<String>,
}

/// 一类轨道（音频或字幕）的选轨语义，三态：
///
/// - `All`：字段缺失或 `null` —— 保留该类全部轨（默认）。
/// - `None`：显式 `[]` —— 该类一条也不保留（如"全部音频 + 不要字幕"）。
/// - `Only(Vec<TrackId>)`：非空数组 —— 只保留列出的轨，缺一即报错。
///
/// 之所以不能用"空数组 = 全部"：那样"全部音频 + 不要字幕"无法表达。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrackChoice {
    All,
    None,
    Only(Vec<TrackId>),
}

impl TrackChoice {
    /// 从协议字段解析。`None`/`null` → `All`；`[]` → `None`；非空 → `Only`。
    /// 元素不是字符串或 id 无法解析时返回 `Err`（带原始值供报错）。
    pub fn parse(value: Option<&Value>) -> Result<Self, String> {
        match value {
            None | Some(Value::Null) => Ok(TrackChoice::All),
            Some(Value::Array(items)) if items.is_empty() => Ok(TrackChoice::None),
            Some(Value::Array(items)) => {
                let mut ids = Vec::with_capacity(items.len());
                for item in items {
                    let raw = item.as_str().ok_or_else(|| "<非字符串>".to_string())?;
                    let id = TrackId::decode(raw).ok_or_else(|| raw.to_string())?;
                    ids.push(id);
                }
                Ok(TrackChoice::Only(ids))
            }
            Some(_) => Err("<非数组>".to_string()),
        }
    }
}

impl TrackId {
    pub fn encode(&self) -> String {
        let lang = self.language.as_deref().unwrap_or("und");
        format!("s{}:p{}:{}", self.index, self.pid, lang)
    }

    pub fn decode(raw: &str) -> Option<Self> {
        let mut parts = raw.split(':');
        let index = parts.next()?.strip_prefix('s')?.parse().ok()?;
        let pid = parts.next()?.strip_prefix('p')?.parse().ok()?;
        let language = match parts.next()? {
            "und" => None,
            other => Some(other.to_string()),
        };
        Some(TrackId {
            index,
            pid,
            language,
        })
    }
}

/// 一个标题的持久标识与内容指纹。
#[derive(Debug, Clone, PartialEq)]
pub struct TitleIdentity {
    pub stable_id: String,
    /// extents 首 LBA；无 extents 时为 None。
    pub first_lba: Option<u32>,
    /// extents 覆盖的总扇区数。
    pub sectors: u64,
    /// 声明时长（秒）。
    pub duration_secs: f64,
    /// 声明大小（字节）。
    pub size_bytes: u64,
}

pub fn format_id(format: DiscFormat) -> &'static str {
    match format {
        DiscFormat::Uhd => "uhd",
        DiscFormat::Fmts => "fmts",
        DiscFormat::BluRay => "bluray",
        DiscFormat::HdDvd => "hddvd",
        DiscFormat::Dvd => "dvd",
        DiscFormat::Unknown => "unknown",
    }
}

pub fn language_of(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_ascii_lowercase())
}

/// 该标题在光盘内容里的持久部分：playlist 名（BD 的 mpls、DVD 的 VTS VOB 名）。
fn persistent_part(title: &DiscTitle, format: DiscFormat) -> String {
    if title.playlist.is_empty() {
        return format!("id{}", title.playlist_id);
    }
    match format {
        DiscFormat::Dvd => title.playlist.clone(),
        _ => title.playlist.clone(),
    }
}

/// 计算每个标题的稳定 id。同持久标识的多条记录按首 LBA 排序后追加序号。
pub fn title_identities(disc: &Disc) -> Vec<TitleIdentity> {
    let mut out: Vec<TitleIdentity> = disc
        .titles
        .iter()
        .map(|title| {
            let first_lba = title.extents.iter().map(|e| e.start_lba).min();
            let sectors = title
                .extents
                .iter()
                .map(|e| u64::from(e.sector_count))
                .sum();
            TitleIdentity {
                stable_id: String::new(),
                first_lba,
                sectors,
                duration_secs: title.duration_secs,
                size_bytes: title.size_bytes,
            }
        })
        .collect();
    let parts: Vec<String> = disc
        .titles
        .iter()
        .map(|t| persistent_part(t, disc.format))
        .collect();
    // 同一持久标识可能对应多条标题（DVD 多 PGC、BD 多 playlist 指向同一内容），
    // 按 extents 首 LBA 排序后追加序号，使 id 在同一张盘的重复扫描间保持稳定。
    let mut groups: std::collections::BTreeMap<String, Vec<usize>> =
        std::collections::BTreeMap::new();
    for (idx, part) in parts.iter().enumerate() {
        groups.entry(part.clone()).or_default().push(idx);
    }
    for (part, mut idxs) in groups {
        idxs.sort_by_key(|&i| (out[i].first_lba.unwrap_or(u32::MAX), i));
        for (n, &idx) in idxs.iter().enumerate() {
            out[idx].stable_id = if idxs.len() == 1 {
                format!("{}/{}", format_id(disc.format), part)
            } else {
                format!("{}/{}#{}", format_id(disc.format), part, n + 1)
            };
        }
    }
    out
}

/// 依据 titleId 在扫描结果里定位标题。
///
/// `expected` 是调用方（前端）在 probe 阶段拿到的指纹；给了才做真正的跨调用校验，
/// 不给则只做持久标识匹配。**绝不**把"同一份扫描自己比自己"当成校验——
/// 那永远是恒等的，只会制造虚假的安全感。
pub fn find_title(
    disc: &Disc,
    title_id: &str,
    expected: Option<&TitleIdentity>,
) -> Result<usize, TitleLookup> {
    let fresh = title_identities(disc);
    let idx = fresh
        .iter()
        .position(|id| id.stable_id == title_id)
        .ok_or(TitleLookup::Unknown)?;
    if let Some(want) = expected {
        let got = &fresh[idx];
        if got.first_lba != want.first_lba
            || got.sectors != want.sectors
            || !duration_close(got.duration_secs, want.duration_secs)
            || got.size_bytes != want.size_bytes
        {
            return Err(TitleLookup::Mismatch {
                expected: describe(want),
                found: describe(got),
            });
        }
    }
    Ok(idx)
}

/// 解析协议里可选的 `titleFingerprint`（probe 时由前端带回的指纹）。
/// 字段缺失或为 null 时返回 `None`：此时不做跨调用校验。
pub fn parse_fingerprint(value: Option<&serde_json::Value>) -> Option<TitleIdentity> {
    let obj = value?.as_object()?;
    Some(TitleIdentity {
        stable_id: obj.get("id")?.as_str()?.to_string(),
        first_lba: obj
            .get("firstLba")
            .and_then(serde_json::Value::as_u64)
            .map(|v| v as u32),
        sectors: obj.get("sectors")?.as_u64()?,
        duration_secs: obj.get("durationSecs")?.as_f64()?,
        size_bytes: obj.get("sizeBytes")?.as_u64()?,
    })
}

fn duration_close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1.0
}

fn describe(id: &TitleIdentity) -> String {
    format!(
        "{}:{}:{}:{}",
        id.stable_id,
        id.first_lba
            .map(|l| l.to_string())
            .unwrap_or_else(|| "-".into()),
        id.sectors,
        id.size_bytes
    )
}

#[derive(Debug)]
pub enum TitleLookup {
    Unknown,
    Mismatch { expected: String, found: String },
}

/// 一条流在协议里的 id（与 `TrackId::encode` 一致），供 rip 侧校验用户选轨。
pub fn stream_id_of(stream: &Stream, index: usize) -> String {
    let (language, pid) = match stream {
        Stream::Video(v) => (None, v.pid),
        Stream::Audio(a) => (language_of(&a.language), a.pid),
        Stream::Subtitle(s) => (language_of(&s.language), s.pid),
    };
    TrackId {
        index,
        pid,
        language,
    }
    .encode()
}

pub fn codec_id(codec: Codec) -> String {
    codec.id().to_string()
}

pub fn resolution_id(res: Resolution) -> Option<String> {
    res.pixels().map(|(w, h)| format!("{w}x{h}"))
}

/// 一条流的协议表示。id 与 `TrackId::encode` 一致。
pub fn stream_view(stream: &Stream, index: usize) -> (String, Value) {
    match stream {
        Stream::Video(v) => {
            let mut m = Map::new();
            m.insert(
                "id".into(),
                Value::String(TrackId::encode(&TrackId {
                    index,
                    pid: v.pid,
                    language: None,
                })),
            );
            m.insert("codec".into(), Value::String(codec_id(v.codec)));
            m.insert("language".into(), Value::Null);
            m.insert("label".into(), Value::String(v.label.clone()));
            if let Some(res) = resolution_id(v.resolution) {
                m.insert("resolution".into(), Value::String(res));
            }
            ("video".into(), Value::Object(m))
        }
        Stream::Audio(a) => {
            let mut m = Map::new();
            m.insert(
                "id".into(),
                Value::String(TrackId::encode(&TrackId {
                    index,
                    pid: a.pid,
                    language: language_of(&a.language),
                })),
            );
            m.insert("codec".into(), Value::String(codec_id(a.codec)));
            m.insert(
                "language".into(),
                language_of(&a.language)
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            m.insert("label".into(), Value::String(a.label.clone()));
            ("audio".into(), Value::Object(m))
        }
        Stream::Subtitle(s) => {
            let mut m = Map::new();
            m.insert(
                "id".into(),
                Value::String(TrackId::encode(&TrackId {
                    index,
                    pid: s.pid,
                    language: language_of(&s.language),
                })),
            );
            m.insert("codec".into(), Value::String(codec_id(s.codec)));
            m.insert(
                "language".into(),
                language_of(&s.language)
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            m.insert("label".into(), Value::String(String::new()));
            ("subtitle".into(), Value::Object(m))
        }
    }
}
