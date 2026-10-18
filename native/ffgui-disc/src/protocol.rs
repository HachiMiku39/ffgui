//! NDJSON 协议编解码：stdin 读请求，stdout 只发事件。
//!
//! 一行一个 JSON 对象。请求带 `version`/`id`/`method`/`params`；事件带
//! `version`/`id`/`type` 与类型相关字段。协议错误用 `FFGUI_*` 前缀，
//! 引擎错误码原样字符串化。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    pub version: u32,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub version: u32,
    pub id: String,
    #[serde(flatten)]
    pub body: EventBody,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum EventBody {
    Progress(ProgressEvent),
    Log(LogEvent),
    Result { result: Value },
    Error { error: ErrorEvent },
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub phase: String,
    #[serde(rename = "bytesDone")]
    pub bytes_done: u64,
    #[serde(rename = "bytesTotal")]
    pub bytes_total: u64,
    #[serde(rename = "speedBps", skip_serializing_if = "Option::is_none")]
    pub speed_bps: Option<u64>,
    #[serde(rename = "etaSecs", skip_serializing_if = "Option::is_none")]
    pub eta_secs: Option<u64>,
    /// 上游引擎的原始 pass 名（`mux`/`sync`/`verify`/`sweep`/…），原样透传。
    /// `phase` 是兼容 Node 端的粗粒度归类，两者并存。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pass: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEvent {
    pub level: String,
    pub code: String,
    pub params: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorEvent {
    pub code: String,
    pub params: Map<String, Value>,
}

impl Event {
    pub fn progress(
        id: &str,
        phase: &str,
        done: u64,
        total: u64,
        speed: Option<u64>,
        eta: Option<u64>,
    ) -> Self {
        Event {
            version: PROTOCOL_VERSION,
            id: id.to_string(),
            body: EventBody::Progress(ProgressEvent {
                phase: phase.to_string(),
                bytes_done: done,
                bytes_total: total,
                speed_bps: speed,
                eta_secs: eta,
                pass: None,
            }),
        }
    }

    /// 附加上游原始 pass 名的 progress 事件（`phase` 仍保留以兼容既有前端）。
    #[allow(clippy::too_many_arguments)]
    pub fn progress_with_pass(
        id: &str,
        phase: &str,
        pass: &str,
        done: u64,
        total: u64,
        speed: Option<u64>,
        eta: Option<u64>,
    ) -> Self {
        Event {
            version: PROTOCOL_VERSION,
            id: id.to_string(),
            body: EventBody::Progress(ProgressEvent {
                phase: phase.to_string(),
                bytes_done: done,
                bytes_total: total,
                speed_bps: speed,
                eta_secs: eta,
                pass: Some(pass.to_string()),
            }),
        }
    }

    pub fn log(id: &str, level: &str, code: &str, params: Map<String, Value>) -> Self {
        Event {
            version: PROTOCOL_VERSION,
            id: id.to_string(),
            body: EventBody::Log(LogEvent {
                level: level.to_string(),
                code: code.to_string(),
                params,
            }),
        }
    }

    pub fn result(id: &str, result: Value) -> Self {
        Event {
            version: PROTOCOL_VERSION,
            id: id.to_string(),
            body: EventBody::Result { result },
        }
    }

    pub fn error(id: &str, code: &str, params: Map<String, Value>) -> Self {
        Event {
            version: PROTOCOL_VERSION,
            id: id.to_string(),
            body: EventBody::Error {
                error: ErrorEvent {
                    code: code.to_string(),
                    params,
                },
            },
        }
    }
}
