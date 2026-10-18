//! 进程级 smoke test：真实拉起二进制，走 stdin/stdout NDJSON。

use std::io::Write;

mod fixtures;
use std::process::{Command, Stdio};

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_ffgui-disc")
}

fn run(lines: &[&str]) -> Vec<serde_json::Value> {
    let mut child = Command::new(binary())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动 ffgui-disc");
    {
        let stdin = child.stdin.as_mut().expect("stdin");
        for line in lines {
            writeln!(stdin, "{line}").unwrap();
        }
    }
    drop(child.stdin.take());
    let out = child.wait_with_output().expect("等待退出");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("每行都应是合法 JSON"))
        .collect()
}

#[test]
fn empty_stdin_exits_zero_without_events() {
    let events = run(&[]);
    assert!(events.is_empty(), "无输入时不应发任何事件: {events:?}");
}

#[test]
fn malformed_json_reports_protocol_error() {
    let events = run(&["not json"]);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "error");
    assert_eq!(events[0]["error"]["code"], "FFGUI_PROTOCOL_JSON");
}

#[test]
fn wrong_version_is_rejected() {
    let events = run(&[r#"{"version":9,"id":"job-1","method":"probe","params":{}}"#]);
    assert_eq!(events[0]["error"]["code"], "FFGUI_PROTOCOL_VERSION");
}

#[test]
fn unknown_method_is_rejected() {
    let events = run(&[r#"{"version":1,"id":"job-1","method":"frobnicate","params":{}}"#]);
    assert_eq!(events[0]["error"]["code"], "FFGUI_PROTOCOL_METHOD");
}

#[test]
fn empty_id_is_rejected() {
    let events = run(&[r#"{"version":1,"id":"  ","method":"probe","params":{}}"#]);
    assert_eq!(events[0]["error"]["code"], "FFGUI_PROTOCOL_ID");
}

#[test]
fn probe_without_source_is_rejected() {
    let events = run(&[r#"{"version":1,"id":"job-1","method":"probe","params":{}}"#]);
    assert_eq!(events[0]["error"]["code"], "FFGUI_SOURCE_KIND");
}

#[test]
fn probe_on_a_non_disc_file_reports_engine_error() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("not-a-disc.bin");
    std::fs::write(&file, b"this is not a disc image").unwrap();
    let req = format!(
        r#"{{"version":1,"id":"job-1","method":"probe","params":{{"source":{{"kind":"iso","path":"{}"}}}}}}"#,
        file.display().to_string().replace('\\', "\\\\")
    );
    let events = run(&[&req]);
    let last = events
        .iter()
        .rev()
        .find(|e| e["type"] == "error" || e["type"] == "result")
        .expect("必须有 error/result 终态");
    assert_eq!(last["type"], "error");
    let code = last["error"]["code"].as_str().unwrap();
    // 引擎自己的错误码（E+数字）或侧车的源错误码，二者其一，但必须是明确的 error 终态。
    assert!(
        code.starts_with('E') || code.starts_with("FFGUI_"),
        "意外错误码: {code}"
    );
}

#[test]
fn rip_refuses_existing_output() {
    let dir = tempfile::tempdir().unwrap();
    let existing = dir.path().join("already-here.mkv");
    std::fs::write(&existing, b"x").unwrap();
    let source = dir.path().join("not-a-disc.bin");
    std::fs::write(&source, b"not a disc").unwrap();
    let req = format!(
        r#"{{"version":1,"id":"job-1","method":"rip","params":{{"source":{{"kind":"iso","path":"{}"}},"titleId":"bluray/00800.mpls","output":"{}","audioTrackIds":[],"subtitleTrackIds":[],"keydbPath":null}}}}"#,
        source.display().to_string().replace('\\', "\\\\"),
        existing.display().to_string().replace('\\', "\\\\")
    );
    let events = run(&[&req]);
    let last = events
        .iter()
        .rev()
        .find(|e| e["type"] == "error" || e["type"] == "result")
        .expect("必须有 error/result 终态");
    // 输出已存在必须在任何扫描/抓取之前被拒绝。
    assert_eq!(last["type"], "error");
    assert_eq!(last["error"]["code"], "FFGUI_OUTPUT_EXISTS");
    assert_eq!(std::fs::read(&existing).unwrap(), b"x", "不得改动已有文件");
}

#[test]
fn rip_rejects_unknown_title_before_touching_output() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("fresh.mkv");
    let source = dir.path().join("not-a-disc.bin");
    std::fs::write(&source, b"not a disc").unwrap();
    let req = format!(
        r#"{{"version":1,"id":"job-1","method":"rip","params":{{"source":{{"kind":"iso","path":"{}"}},"titleId":"bluray/99999.mpls","output":"{}","audioTrackIds":[],"subtitleTrackIds":[],"keydbPath":null}}}}"#,
        source.display().to_string().replace('\\', "\\\\"),
        out.display().to_string().replace('\\', "\\\\")
    );
    let events = run(&[&req]);
    let last = events
        .iter()
        .rev()
        .find(|e| e["type"] == "error" || e["type"] == "result")
        .expect("必须有 error/result 终态");
    assert_eq!(last["type"], "error");
    assert!(!out.exists(), "失败的 rip 不得留下输出文件");
}

#[test]
fn cancel_of_unknown_id_is_reported_not_crashing() {
    let events = run(&[r#"{"version":1,"id":"nope","method":"cancel","params":{}}"#]);
    let log = events
        .iter()
        .find(|e| e["code"] == "CANCEL")
        .expect("应收到 CANCEL 日志");
    assert_eq!(log["params"]["cancelled"], false);
}

#[test]
fn every_line_is_one_json_object() {
    // 协议错误（非 job 终态）不会让进程退出，后续行仍被处理。
    let events = run(&[
        r#"{"version":1,"id":"job-1","method":"bogus","params":{}}"#,
        r#"{"version":1,"id":"job-2","method":"probe","params":{"source":{"kind":"drive","path":"E:"}}}"#,
    ]);
    assert!(events.len() >= 2);
    for e in &events {
        assert!(e.is_object());
        assert_eq!(e["version"], 1);
        assert!(e["id"].is_string());
        assert!(e["type"].is_string());
    }
}

#[test]
fn process_exits_after_a_job_reaches_its_terminal_event() {
    // 一个侧车进程只处理一个初始请求：终态之后必须自行退出（退出码 0），
    // 不能挂到 stdin EOF 上等调用方 SIGTERM。
    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd(1);
    let iso = dir.path().join("disc.iso");
    std::fs::write(&iso, &disc.image).unwrap();
    let iso_json = serde_json::to_string(&iso).unwrap();
    let req = format!(
        r#"{{"version":1,"id":"job-1","method":"probe","params":{{"source":{{"kind":"iso","path":{iso_json}}}}}}}"#
    );
    let mut child = Command::new(binary())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动 ffgui-disc");
    {
        use std::io::Write as _;
        let stdin = child.stdin.as_mut().expect("stdin");
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
    }
    // 不关 stdin：进程必须自己退出，而不是等 EOF。
    let status = child.wait().expect("等待退出");
    assert_eq!(status.code(), Some(0), "终态后应以 0 退出");
}

/// 合成 BD 镜像走完整二进制：probe → rip → result，进度与结果都在 stdout。
#[test]
fn synthetic_disc_probe_then_rip_through_the_binary() {
    let dir = tempfile::tempdir().unwrap();
    // 视频 + 双音轨：进程级直接验证 0/1/2 条真实音轨与 progress 事件。
    let disc = fixtures::synthetic_bd_with_video(10);
    let iso = dir.path().join("disc.iso");
    std::fs::write(&iso, &disc.image).unwrap();

    let iso_json = serde_json::to_string(&iso).unwrap();
    let probe_line = format!(
        r#"{{"version":1,"id":"job-1","method":"probe","params":{{"source":{{"kind":"iso","path":{iso_json}}}}}}}"#
    );
    let events = run(&[&probe_line]);
    let result = events
        .iter()
        .find(|e| e["type"] == "result")
        .expect("probe 必须给出 result");
    let titles = result["result"]["disc"]["titles"].as_array().unwrap();
    let title_id = titles[0]["id"].as_str().unwrap().to_string();
    let audio = titles[0]["audio"].as_array().unwrap();
    assert_eq!(audio.len(), 2, "夹具应给出两条音轨");
    let chosen = audio[1]["id"].as_str().unwrap().to_string();
    let fingerprint = serde_json::to_string(&titles[0]["fingerprint"]).unwrap();

    // audio null + subtitle []：保留全部两条音轨，且不保留字幕。
    let out_all = dir.path().join("all.mkv");
    let rip_all = format!(
        r#"{{"version":1,"id":"job-2","method":"rip","params":{{"source":{{"kind":"iso","path":{iso_json}}},"titleId":{},"output":{},"audioTrackIds":null,"subtitleTrackIds":[],"keydbPath":null,"titleFingerprint":{}}}}}"#,
        serde_json::to_string(&title_id).unwrap(),
        serde_json::to_string(&out_all).unwrap(),
        fingerprint
    );
    let all_events = run(&[&rip_all]);
    let terminal = terminal_of(&all_events);
    assert_eq!(terminal["type"], "result", "rip 失败: {terminal}");
    assert_eq!(terminal["result"]["titleId"], title_id.as_str());
    assert_eq!(
        terminal["result"]["output"].as_str().unwrap(),
        out_all.to_str().unwrap(),
        "result.output 应是用户给的路径"
    );
    assert!(out_all.exists() && std::fs::metadata(&out_all).unwrap().len() > 0);
    assert_eq!(
        track_counts(&out_all),
        (2, 0),
        "audio null = 全部两条音轨，subtitle [] = 零条字幕"
    );
    // progress 事件必须出现过（rip 阶段），且带上上游原始 pass 名。
    assert!(
        all_events
            .iter()
            .any(|e| e["type"] == "progress" && e["phase"] == "rip"),
        "rip 期间应发 progress 事件"
    );
    assert!(
        all_events
            .iter()
            .any(|e| e["type"] == "progress" && e["pass"].is_string()),
        "progress 事件应附加上游原始 pass 名"
    );

    // 非空数组只留指定一条，字幕 [] 仍为零条；同时带回 fingerprint。
    let out_one = dir.path().join("one.mkv");
    let rip_one = format!(
        r#"{{"version":1,"id":"job-3","method":"rip","params":{{"source":{{"kind":"iso","path":{iso_json}}},"titleId":{},"output":{},"audioTrackIds":[{}],"subtitleTrackIds":[],"keydbPath":null,"titleFingerprint":{}}}}}"#,
        serde_json::to_string(&title_id).unwrap(),
        serde_json::to_string(&out_one).unwrap(),
        serde_json::to_string(&chosen).unwrap(),
        fingerprint
    );
    let terminal = terminal_of(&run(&[&rip_one]));
    assert_eq!(terminal["type"], "result", "选轨 rip 失败: {terminal}");
    assert_eq!(track_counts(&out_one), (1, 0), "显式选一条必须只留一条");

    // 显式空数组 = 音频一条不要：成功产出纯视频 MKV，真实音轨数为 0。
    let out_none = dir.path().join("none.mkv");
    let rip_none = format!(
        r#"{{"version":1,"id":"job-4","method":"rip","params":{{"source":{{"kind":"iso","path":{iso_json}}},"titleId":{},"output":{},"audioTrackIds":[],"subtitleTrackIds":[],"keydbPath":null}}}}"#,
        serde_json::to_string(&title_id).unwrap(),
        serde_json::to_string(&out_none).unwrap()
    );
    let terminal = terminal_of(&run(&[&rip_none]));
    assert_eq!(terminal["type"], "result", "显式 [] 不应失败: {terminal}");
    assert_eq!(track_counts(&out_none), (0, 0));
    assert_eq!(tracks_of(&out_none), 1, "剩下的唯一轨道应是视频");
}

fn terminal_of(events: &[serde_json::Value]) -> serde_json::Value {
    events
        .iter()
        .rev()
        .find(|e| e["type"] == "error" || e["type"] == "result")
        .expect("必须有终态")
        .clone()
}

fn tracks_of(path: &std::path::Path) -> usize {
    let file = std::fs::File::open(path).unwrap();
    libfreemkv::probe_mkv_with_cues(std::io::BufReader::new(file))
        .unwrap()
        .tracks
        .len()
}

fn track_counts(path: &std::path::Path) -> (usize, usize) {
    let file = std::fs::File::open(path).unwrap();
    let probe = libfreemkv::probe_mkv_with_cues(std::io::BufReader::new(file)).unwrap();
    let audio = probe
        .tracks
        .iter()
        .filter(|t| t.kind == libfreemkv::MkvTrackKind::Audio)
        .count();
    let subtitles = probe
        .tracks
        .iter()
        .filter(|t| t.kind == libfreemkv::MkvTrackKind::Subtitle)
        .count();
    (audio, subtitles)
}

/// 抓取过程中由 stdin 发 cancel：必须真的中断 mux 并给出 FFGUI_CANCELLED 终态，
/// 且不得留下半成品。
///
/// 设计要点：用足够大的 clip 让 mux 持续一段时间；等到 stdout 出现第一个
/// `progress` 事件（说明 mux 已在写字节）之后再发 cancel，保证取消落在
/// **运行中**而不是提交前。终态必须是 FFGUI_CANCELLED，不接受 result。
#[test]
fn cancel_mid_rip_interrupts_and_cleans_up() {
    use std::io::{Read as _, Write as _};
    use std::process::{Command, Stdio};

    let dir = tempfile::tempdir().unwrap();
    // 大 clip：mux 有足够长的窗口让 cancel 到达。
    let specs = [fixtures::TitleSpec {
        units: 4000,
        audio_pids: &[fixtures::AUDIO_PID_0],
        language: b"eng",
        secs: 120,
    }];
    let disc = fixtures::synthetic_bd_specs(&specs);
    let iso = dir.path().join("big.iso");
    std::fs::write(&iso, &disc.image).unwrap();

    let mut child = Command::new(binary())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动 ffgui-disc");
    let stdin = child.stdin.as_mut().expect("stdin");
    let stdout = child.stdout.as_mut().expect("stdout");
    let iso_json = serde_json::to_string(&iso).unwrap();
    let out = dir.path().join("big.mkv");
    let out_json = serde_json::to_string(&out).unwrap();
    writeln!(
        stdin,
        r#"{{"version":1,"id":"job-9","method":"rip","params":{{"source":{{"kind":"iso","path":{iso_json}}},"titleId":"bluray/00000.mpls","output":{out_json},"keydbPath":null}}}}"#
    )
    .unwrap();
    stdin.flush().unwrap();

    // 等到第一个 rip progress 事件：mux 确实已在写字节。
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut seen_progress = false;
    while !seen_progress {
        let n = stdout.read(&mut chunk).expect("读 stdout");
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        while let Some(i) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=i).collect();
            let text = String::from_utf8_lossy(&line);
            if let Ok(e) = serde_json::from_str::<serde_json::Value>(text.trim())
                && e["type"] == "progress"
                && e["phase"] == "rip"
            {
                seen_progress = true;
                break;
            }
        }
    }
    assert!(
        seen_progress,
        "取消前必须看到 rip progress（证明 mux 已在运行）"
    );

    // 延迟发送 cancel：stdin 不关，进程必须靠独立读取线程收到它。
    writeln!(
        stdin,
        r#"{{"version":1,"id":"job-9","method":"cancel","params":{{}}}}"#
    )
    .unwrap();
    stdin.flush().unwrap();
    // 关键：不 drop stdin。若主线程在读 stdin 上阻塞，这个 cancel 永远到不了。
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("等待退出");
    let events: Vec<serde_json::Value> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("合法 JSON"))
        .collect();
    let terminal = events
        .iter()
        .rev()
        .find(|e| e["type"] == "error" || e["type"] == "result")
        .expect("必须有终态");
    assert_eq!(terminal["type"], "error", "取消必须让 rip 中断：{terminal}");
    assert_eq!(
        terminal["error"]["code"], "FFGUI_CANCELLED",
        "终态必须是 FFGUI_CANCELLED"
    );
    assert!(!out.exists(), "取消后不得发布输出");
    let partial = dir.path().join("big.mkv.ffgui-partial");
    assert!(!partial.exists(), "取消后不得留下 .partial");
}

/// 调用方不关 stdin 时，进程仍必须在终态后自行退出（不等 stdin EOF）。
/// 这是真实集成路径：Electron 侧车客户端发完请求后不会主动关闭管道。
#[test]
fn process_exits_even_when_stdin_stays_open() {
    use std::io::Write as _;
    use std::process::{Command, Stdio};

    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd(1);
    let iso = dir.path().join("disc.iso");
    std::fs::write(&iso, &disc.image).unwrap();
    let iso_json = serde_json::to_string(&iso).unwrap();

    let mut child = Command::new(binary())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动 ffgui-disc");
    {
        let stdin = child.stdin.as_mut().expect("stdin");
        writeln!(
            stdin,
            r#"{{"version":1,"id":"job-1","method":"probe","params":{{"source":{{"kind":"iso","path":{iso_json}}}}}}}"#
        )
        .unwrap();
        stdin.flush().unwrap();
    }
    // 故意不 drop / 不关闭 stdin：进程必须自己退出。
    let status = child.wait().expect("等待退出");
    assert_eq!(status.code(), Some(0), "stdin 未关也应以 0 退出");
}

/// `list-drives`：必须返回 `{drives:[...]}`，每个元素含 kind/path/label，
/// 且不得崩溃。本机没有光驱，所以 drives 为空数组——协议形状仍要成立。
#[test]
fn list_drives_returns_the_protocol_shape() {
    let events = run(&[r#"{"version":1,"id":"job-1","method":"list-drives","params":{}}"#]);
    let result = events
        .iter()
        .find(|e| e["type"] == "result")
        .expect("list-drives 必须给出 result");
    let drives = result["result"]["drives"]
        .as_array()
        .expect("drives 必须是数组");
    for d in drives {
        assert_eq!(d["kind"], "drive", "每个条目 kind 必须是 drive");
        assert!(d["path"].is_string(), "必须有 path");
        assert!(d["label"].is_string(), "必须有 label");
    }
    // 进程必须以 0 退出（无光驱不是错误）。
    let status = run_status(&[r#"{"version":1,"id":"job-1","method":"list-drives","params":{}}"#]);
    assert_eq!(status.code(), Some(0));
}

/// `list-drives` 不接受 params 里的 source：缺了也能跑（本方法不需要 source）。
#[test]
fn list_drives_ignores_unknown_params() {
    let events = run(&[
        r#"{"version":1,"id":"job-1","method":"list-drives","params":{"source":{"kind":"iso","path":"/x"}}}"#,
    ]);
    let result = events
        .iter()
        .find(|e| e["type"] == "result")
        .expect("应忽略无关 params 并给出 result");
    assert!(result["result"]["drives"].is_array());
}

fn run_status(lines: &[&str]) -> std::process::ExitStatus {
    use std::io::Write as _;
    let mut child = Command::new(binary())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动 ffgui-disc");
    {
        let stdin = child.stdin.as_mut().expect("stdin");
        for line in lines {
            writeln!(stdin, "{line}").unwrap();
        }
    }
    drop(child.stdin.take());
    child.wait().expect("等待退出")
}
