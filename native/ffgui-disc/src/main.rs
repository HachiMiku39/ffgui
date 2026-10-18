//! ffgui-disc：FFGui 的 DVD/BD 光盘抓取侧车进程。
//!
//! 协议：stdin 一行一个 JSON 请求；stdout 只发 NDJSON 事件；stderr 只发脱敏日志。
//! 第一个请求启动一个 job（probe 或 rip），同 id 的 cancel 请求中断它。
//! 退出码 0 不代表成功——成功/失败一律以 result/error 事件表达。
//!
//! stdin 由独立线程持续读取。job 运行期间主线程不碰 stdin，因此运行中的
//! cancel 能立刻被 reader 线程置位到共享标志上（不等主线程来收）。

use ffgui_disc::cancel;
use ffgui_disc::errors::{self as errs, ERR_INTERNAL, ERR_KEYDB, ERR_OUTPUT_PATH};
use ffgui_disc::jobs;
use ffgui_disc::protocol::{Event, PROTOCOL_VERSION, Request};
use ffgui_disc::sink::NdjsonSink;
use ffgui_disc::source::DiscSource;
use serde_json::{Map, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::JoinHandle;

/// 主循环与 reader 线程之间传递的行。cancel 在 reader 线程就地处理
/// （立刻置位共享标志），只有初始请求才交给主循环。
enum StdinLine {
    Request(Box<Request>),
    /// 协议错误：reader 线程无法定位 id，只把原因交给主循环发 error 事件。
    Bad {
        reason: String,
    },
}

fn main() {
    let code = run();
    // 不 join reader 线程：调用方可能一直开着 stdin（协议只约定"一个初始请求"），
    // join 会让进程在终态之后仍挂住。reader 是 detached 线程，进程退出即结束。
    std::process::exit(code);
}

fn run() -> i32 {
    let (tx, rx) = mpsc::sync_channel::<StdinLine>(8);
    let _reader: JoinHandle<()> = std::thread::spawn(move || read_stdin(tx));
    serve(&rx)
}

/// reader 线程：逐行读 stdin。cancel 立即置位共享标志（不等主线程），
/// 其余行转交主循环。
fn read_stdin(tx: SyncSender<StdinLine>) {
    let stdin = std::io::stdin();
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.lock().read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.send(StdinLine::Bad {
                    reason: e.to_string(),
                });
                continue;
            }
        };
        if request.method == "cancel" {
            // 运行中的取消必须立刻生效：reader 线程直接置位，
            // 不经过可能正被 job 占用的主循环。
            let _ = cancel::cancel(&request.id);
            let _ = tx.send(StdinLine::Request(Box::new(request)));
            continue;
        }
        if tx.send(StdinLine::Request(Box::new(request))).is_err() {
            break;
        }
    }
}

fn serve(rx: &Receiver<StdinLine>) -> i32 {
    loop {
        match rx.recv() {
            Err(_) => return 0,
            Ok(StdinLine::Bad { reason }) => {
                emit_error(
                    "",
                    errs::ERR_PROTOCOL_JSON,
                    &[("reason", Value::String(reason))],
                );
            }
            Ok(StdinLine::Request(request)) => {
                if request.version != PROTOCOL_VERSION {
                    emit_error(
                        &request.id,
                        errs::ERR_PROTOCOL_VERSION,
                        &[
                            ("want", Value::from(PROTOCOL_VERSION)),
                            ("got", Value::from(request.version)),
                        ],
                    );
                    continue;
                }
                if request.id.trim().is_empty() {
                    emit_error("", errs::ERR_PROTOCOL_ID, &[]);
                    continue;
                }
                match request.method.as_str() {
                    "probe" | "rip" => {
                        // 取消标志必须先登记，job 与 cancel 读到的才是同一个实例。
                        let _flag = cancel::register(&request.id);
                        let outcome = run_job(&request);
                        emit_outcome(&request.id, outcome);
                        // 协议约定一个侧车进程只处理一个初始请求：终态之后主动退出，
                        // 让调用方以退出码 0 收尾，而不是挂到 stdin EOF。
                        return 0;
                    }
                    "list-drives" => {
                        let outcome = jobs::list_drives();
                        emit_outcome(&request.id, outcome);
                        return 0;
                    }
                    "cancel" => {
                        // reader 线程已置位；这里只补一条日志。
                        let found = cancel::is_cancelled(&request.id);
                        let mut params = Map::new();
                        params.insert("cancelled".into(), Value::Bool(found));
                        emit_log(&request.id, "info", "CANCEL", params);
                    }
                    other => {
                        emit_error(
                            &request.id,
                            errs::ERR_PROTOCOL_METHOD,
                            &[("method", Value::String(other.to_string()))],
                        );
                    }
                }
            }
        }
    }
}

fn run_job(request: &Request) -> Result<Value, (String, Map<String, Value>)> {
    let sink = NdjsonSink::new(&request.id);
    let params = request
        .params
        .as_object()
        .ok_or_else(|| (errs::ERR_PROTOCOL_PARAMS.to_string(), Map::new()))?;
    let source = parse_source(params)?;
    match request.method.as_str() {
        "probe" => jobs::probe(&sink, &source),
        "rip" => {
            let title_id = str_field(params, "titleId")?;
            let output_raw = str_field(params, "output")?;
            let output = PathBuf::from(&output_raw);
            let absolute = std::path::absolute(&output).map_err(|_| {
                (
                    ERR_OUTPUT_PATH.to_string(),
                    errs::params(&[("path", Value::String(output_raw.clone()))]),
                )
            })?;
            if absolute.parent().is_none_or(|p| !p.is_dir()) {
                return Err((
                    ERR_OUTPUT_PATH.to_string(),
                    errs::params(&[("path", Value::String(output_raw))]),
                ));
            }
            let output = absolute;
            // 三态选轨：字段缺失/null = 全部；显式 [] = 一条不保留；非空 = 只保留指定轨。
            let audio = ffgui_disc::model::TrackChoice::parse(params.get("audioTrackIds"))
                .map_err(|bad| track_ids_error("audioTrackIds", &bad))?;
            let subtitle = ffgui_disc::model::TrackChoice::parse(params.get("subtitleTrackIds"))
                .map_err(|bad| track_ids_error("subtitleTrackIds", &bad))?;
            let keydb = match params.get("keydbPath") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if s.trim().is_empty() => None,
                Some(Value::String(s)) => {
                    let p = PathBuf::from(s);
                    // 在线密钥服务默认禁用；显式给的 keydb 必须存在，否则明确报错，
                    // 不让一个拼错的路径静默变成"无密钥源"。
                    if !p.is_file() {
                        return Err((
                            ERR_KEYDB.to_string(),
                            errs::params(&[("path", Value::String(s.clone()))]),
                        ));
                    }
                    Some(p)
                }
                Some(_) => return Err((ERR_KEYDB.to_string(), Map::new())),
            };
            // 阻塞工作在 worker 线程，stdin 的 cancel 可以中断它。
            let fingerprint = params.get("titleFingerprint").cloned();
            let handle = std::thread::spawn(move || {
                jobs::rip(
                    &sink,
                    &source,
                    &title_id,
                    &output,
                    &audio,
                    &subtitle,
                    keydb.as_deref(),
                    fingerprint.as_ref(),
                )
            });
            handle.join().unwrap_or_else(|_| {
                Err((
                    ERR_INTERNAL.to_string(),
                    errs::params(&[("reason", Value::String("worker panicked".into()))]),
                ))
            })
        }
        _ => Err((errs::ERR_PROTOCOL_METHOD.to_string(), Map::new())),
    }
}

fn parse_source(params: &Map<String, Value>) -> Result<DiscSource, (String, Map<String, Value>)> {
    let source = params
        .get("source")
        .and_then(Value::as_object)
        .ok_or_else(|| (errs::ERR_SOURCE_KIND.to_string(), Map::new()))?;
    let kind = source
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| (errs::ERR_SOURCE_KIND.to_string(), Map::new()))?;
    let path = source
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| (errs::ERR_SOURCE_PATH.to_string(), Map::new()))?;
    DiscSource::parse(kind, path).map_err(|bad| {
        let code = if matches!(bad.as_str(), "iso" | "folder" | "drive") {
            match bad.as_str() {
                "drive" => errs::ERR_UNSUPPORTED,
                _ => errs::ERR_SOURCE_NOT_FOUND,
            }
        } else {
            errs::ERR_SOURCE_KIND
        };
        let mut m = Map::new();
        m.insert("kind".into(), Value::String(kind.to_string()));
        m.insert("path".into(), Value::String(path.to_string()));
        (code.to_string(), m)
    })
}

fn str_field(
    params: &Map<String, Value>,
    key: &str,
) -> Result<String, (String, Map<String, Value>)> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            let mut m = Map::new();
            m.insert("field".into(), Value::String(key.to_string()));
            (errs::ERR_PROTOCOL_PARAMS.to_string(), m)
        })
}

/// 选轨字段解析失败的报错：带上字段名与原始值（可能是 \"<非字符串>\" / \"<非数组>\"）。
fn track_ids_error(field: &str, bad: &str) -> (String, Map<String, Value>) {
    let mut m = Map::new();
    m.insert("field".into(), Value::String(field.to_string()));
    m.insert("value".into(), Value::String(bad.to_string()));
    (errs::ERR_TRACK_IDS.to_string(), m)
}

fn emit_outcome(id: &str, outcome: Result<Value, (String, Map<String, Value>)>) {
    match outcome {
        Ok(result) => emit(Event::result(id, result)),
        Err((code, params)) => emit(Event::error(id, &code, params)),
    }
}

fn emit_error(id: &str, code: &str, params: &[(&str, Value)]) {
    emit(Event::error(id, code, errs::params(params)));
}

fn emit_log(id: &str, level: &str, code: &str, params: Map<String, Value>) {
    emit(Event::log(id, level, code, params));
}

fn emit(event: Event) {
    let line = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    let _ = writeln!(lock, "{line}");
    let _ = lock.flush();
}
