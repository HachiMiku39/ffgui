//! 协议编解码与事件序列化的单元测试。

use ffgui_disc::protocol::{Event, PROTOCOL_VERSION, Request};
use serde_json::{Map, Value};

fn parse(line: &str) -> Value {
    serde_json::from_str(line).unwrap()
}

#[test]
fn request_parses_probe() {
    let line = r#"{"version":1,"id":"job-1","method":"probe","params":{"source":{"kind":"iso","path":"/tmp/a.iso"}}}"#;
    let req: Request = serde_json::from_str(line).unwrap();
    assert_eq!(req.version, PROTOCOL_VERSION);
    assert_eq!(req.id, "job-1");
    assert_eq!(req.method, "probe");
    assert_eq!(req.params["source"]["kind"], "iso");
}

#[test]
fn request_parses_rip_with_three_state_track_choices() {
    let line = r#"{"version":1,"id":"job-1","method":"rip","params":{"source":{"kind":"folder","path":"/tmp/d"},"titleId":"dvd/VTS_01_1.VOB","output":"/tmp/out.mkv","audioTrackIds":null,"subtitleTrackIds":[],"keydbPath":null}}"#;
    let req: Request = serde_json::from_str(line).unwrap();
    assert_eq!(req.method, "rip");
    assert_eq!(req.params["keydbPath"], Value::Null);
    let params = req.params.as_object().unwrap();
    assert_eq!(
        ffgui_disc::model::TrackChoice::parse(params.get("audioTrackIds")).unwrap(),
        ffgui_disc::model::TrackChoice::All,
        "audio null 必须保留全部音轨"
    );
    assert_eq!(
        ffgui_disc::model::TrackChoice::parse(params.get("subtitleTrackIds")).unwrap(),
        ffgui_disc::model::TrackChoice::None,
        "subtitle 显式 [] 必须排除全部字幕轨"
    );
}

#[test]
fn request_parses_list_drives() {
    let line = r#"{"version":1,"id":"job-1","method":"list-drives","params":{}}"#;
    let req: Request = serde_json::from_str(line).unwrap();
    assert_eq!(req.method, "list-drives");
    assert!(req.params.is_object());
}

#[test]
fn request_parses_cancel() {
    let line = r#"{"version":1,"id":"job-1","method":"cancel","params":{}}"#;
    let req: Request = serde_json::from_str(line).unwrap();
    assert_eq!(req.method, "cancel");
}

#[test]
fn progress_event_shape() {
    let e = Event::progress("job-1", "rip", 10, 100, Some(5), Some(18));
    let v = parse(&serde_json::to_string(&e).unwrap());
    assert_eq!(v["version"], 1);
    assert_eq!(v["id"], "job-1");
    assert_eq!(v["type"], "progress");
    assert_eq!(v["phase"], "rip");
    assert_eq!(v["bytesDone"], 10);
    assert_eq!(v["bytesTotal"], 100);
    assert_eq!(v["speedBps"], 5);
    assert_eq!(v["etaSecs"], 18);
}

#[test]
fn progress_event_omits_unknown_speed_and_eta() {
    let e = Event::progress("job-1", "scan", 0, 0, None, None);
    let v = parse(&serde_json::to_string(&e).unwrap());
    assert!(v.get("speedBps").is_none());
    assert!(v.get("etaSecs").is_none());
}

#[test]
fn log_event_shape() {
    let params = Map::new();
    let e = Event::log("job-1", "warning", "ENGINE_LOG", params);
    let v = parse(&serde_json::to_string(&e).unwrap());
    assert_eq!(v["type"], "log");
    assert_eq!(v["level"], "warning");
    assert_eq!(v["code"], "ENGINE_LOG");
    assert!(v["params"].is_object());
}

#[test]
fn result_event_shape() {
    let e = Event::result("job-1", Value::String("ok".into()));
    let v = parse(&serde_json::to_string(&e).unwrap());
    assert_eq!(v["type"], "result");
    assert_eq!(v["result"], "ok");
}

#[test]
fn error_event_shape() {
    let mut params = Map::new();
    params.insert("field".into(), Value::String("titleId".into()));
    let e = Event::error("job-1", "FFGUI_TITLE_UNKNOWN", params);
    let v = parse(&serde_json::to_string(&e).unwrap());
    assert_eq!(v["type"], "error");
    assert_eq!(v["error"]["code"], "FFGUI_TITLE_UNKNOWN");
    assert_eq!(v["error"]["params"]["field"], "titleId");
}

#[test]
fn malformed_request_is_rejected() {
    let bad = "not json";
    assert!(serde_json::from_str::<Request>(bad).is_err());
}

#[test]
fn wrong_version_is_detectable() {
    let line = r#"{"version":2,"id":"job-1","method":"probe","params":{}}"#;
    let req: Request = serde_json::from_str(line).unwrap();
    assert_ne!(req.version, PROTOCOL_VERSION);
}

#[test]
fn progress_event_carries_the_upstream_pass_name() {
    let e = Event::progress_with_pass("job-1", "rip", "mux", 10, 100, Some(5), Some(18));
    let v = parse(&serde_json::to_string(&e).unwrap());
    assert_eq!(v["phase"], "rip");
    assert_eq!(v["pass"], "mux", "pass 应原样透传上游名");
    assert_eq!(v["bytesDone"], 10);
}

#[test]
fn progress_event_omits_pass_when_unknown() {
    let e = Event::progress("job-1", "scan", 0, 0, None, None);
    let v = parse(&serde_json::to_string(&e).unwrap());
    assert!(v.get("pass").is_none(), "无上游 pass 时不应出现该字段");
}
