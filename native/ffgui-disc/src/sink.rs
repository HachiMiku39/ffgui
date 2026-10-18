//! 侧车的 Sink 实现：把引擎的进度/日志/事件翻译成 NDJSON 事件。
//! 不自行重算 speed/ETA，直接透传承引擎的派生值。

use crate::protocol::Event;
use freemkv_engine::{Level, Progress, Sink};
use serde_json::{Map, Value};
use std::io::Write;
use std::sync::Mutex;

pub struct NdjsonSink {
    id: String,
    out: Mutex<std::io::Stdout>,
}

impl NdjsonSink {
    pub fn new(id: &str) -> Self {
        NdjsonSink {
            id: id.to_string(),
            out: Mutex::new(std::io::stdout()),
        }
    }

    pub fn job_id(&self) -> &str {
        &self.id
    }

    /// 发一条侧车自己的结构化 log 事件（非引擎回调路径也能用）。
    pub fn event_log(&self, level: &str, code: &str, params: Map<String, Value>) {
        self.emit(Event::log(&self.id, level, code, params));
    }

    fn emit(&self, event: Event) {
        let line = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
        let mut guard = self.out.lock().unwrap_or_else(|e| e.into_inner());
        let _ = writeln!(guard, "{line}");
        let _ = guard.flush();
    }
}

impl Sink for NdjsonSink {
    fn log(&self, level: Level, msg: &str) {
        // 引擎的日志文本是英文诊断；侧车只做脱敏转发（去掉控制字符、截断长度），
        // 不把它当结构化数据。
        let safe = sanitize(msg);
        let lvl = match level {
            Level::Trace => "debug",
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warning",
            Level::Error => "error",
        };
        let mut params = Map::new();
        params.insert("message".into(), Value::String(safe));
        self.emit(Event::log(&self.id, lvl, "ENGINE_LOG", params));
    }

    fn progress(&self, p: &Progress) {
        // 协议只有 scan/rip 两个 phase；引擎的 pass 名（mux/sync/verify/…）
        // 归入 rip 阶段，速度与 ETA 原样透传。上游原始 pass 名一并带上，
        // 前端可自行细分而不破坏既有 phase 归类。
        let phase = match p.pass.as_ref() {
            "sweep" | "patch-scrape" | "patch-trim" | "extract" | "copy" => "scan",
            _ => "rip",
        };
        let event = Event::progress_with_pass(
            &self.id,
            phase,
            p.pass.as_ref(),
            p.bytes_done,
            p.bytes_total,
            Some(p.speed_bps),
            p.eta_secs,
        );
        self.emit(event);
    }

    fn event(&self, e: &freemkv_engine::Event<'_>) {
        match e {
            freemkv_engine::Event::Phase { name } => {
                let mut params = Map::new();
                params.insert("phase".into(), Value::String((*name).to_string()));
                self.emit(Event::log(&self.id, "info", "ENGINE_PHASE", params));
            }
            freemkv_engine::Event::TitleStart { idx, dest } => {
                let mut params = Map::new();
                params.insert("titleIndex".into(), Value::from(*idx));
                params.insert("dest".into(), Value::String(sanitize(dest)));
                self.emit(Event::log(&self.id, "info", "ENGINE_TITLE_START", params));
            }
            freemkv_engine::Event::TitleDone { idx, result, .. } => {
                let mut params = Map::new();
                params.insert("titleIndex".into(), Value::from(*idx));
                match result {
                    Ok(outcome) => {
                        params.insert("completed".into(), Value::Bool(outcome.completed));
                        params.insert("bytesWritten".into(), Value::from(outcome.bytes_written));
                    }
                    Err(err) => {
                        params.insert("error".into(), Value::String(sanitize(&err.to_string())));
                    }
                }
                self.emit(Event::log(&self.id, "info", "ENGINE_TITLE_DONE", params));
            }
            freemkv_engine::Event::Verify { ok, .. } => {
                let mut params = Map::new();
                params.insert("ok".into(), Value::Bool(*ok));
                self.emit(Event::log(&self.id, "info", "ENGINE_VERIFY", params));
            }
            freemkv_engine::Event::Replaced { .. } => {}
            freemkv_engine::Event::TitleSkipped { idx, .. } => {
                let mut params = Map::new();
                params.insert("titleIndex".into(), Value::from(*idx));
                self.emit(Event::log(&self.id, "info", "ENGINE_TITLE_SKIPPED", params));
            }
            freemkv_engine::Event::TitleFailed { idx, error } => {
                let mut params = Map::new();
                params.insert("titleIndex".into(), Value::from(*idx));
                params.insert("error".into(), Value::String(sanitize(&error.to_string())));
                self.emit(Event::log(&self.id, "error", "ENGINE_TITLE_FAILED", params));
            }
            freemkv_engine::Event::OutputOpened { dest, .. } => {
                let mut params = Map::new();
                params.insert("dest".into(), Value::String(sanitize(dest)));
                self.emit(Event::log(&self.id, "info", "ENGINE_OUTPUT_OPENED", params));
            }
            freemkv_engine::Event::SourceOpened { device, disc } => {
                let mut params = Map::new();
                if let Some(device) = device {
                    params.insert("device".into(), Value::String(sanitize(device)));
                }
                params.insert("titles".into(), Value::from(disc.titles.len()));
                params.insert(
                    "format".into(),
                    Value::String(crate::model::format_id(disc.format).to_string()),
                );
                self.emit(Event::log(&self.id, "info", "ENGINE_SOURCE_OPENED", params));
            }
            freemkv_engine::Event::Keys { trace, ring } => {
                let mut params = Map::new();
                params.insert("resolved".into(), Value::Bool(ring.is_some()));
                params.insert("steps".into(), Value::from(trace.keys.len()));
                self.emit(Event::log(&self.id, "info", "ENGINE_KEYS", params));
            }
            freemkv_engine::Event::Pass(p) => {
                let mut params = Map::new();
                params.insert("bytesDone".into(), Value::from(p.work_done));
                params.insert("bytesTotal".into(), Value::from(p.work_total));
                self.emit(Event::log(&self.id, "info", "ENGINE_PASS", params));
            }
            freemkv_engine::Event::Recovery(r) => {
                let mut params = Map::new();
                params.insert("event".into(), Value::String(format!("{r:?}")));
                self.emit(Event::log(&self.id, "info", "ENGINE_RECOVERY", params));
            }
            _ => {}
        }
    }

    fn should_cancel(&self) -> bool {
        crate::cancel::is_cancelled(&self.id)
    }
}

/// 脱敏：转义控制字符（防伪造行/终端转义），并限制长度。
pub fn sanitize(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len());
    for c in msg.chars() {
        if c.is_control() {
            out.extend(c.escape_default());
        } else {
            out.push(c);
        }
    }
    const LIMIT: usize = 512;
    if out.chars().count() > LIMIT {
        out.chars().take(LIMIT).collect()
    } else {
        out
    }
}
