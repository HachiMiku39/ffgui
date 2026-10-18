//! 源校验与选轨语义的单元测试。

use ffgui_disc::errors;
use ffgui_disc::model::TrackId;
use ffgui_disc::source::{DiscSource, SourceKind};

#[test]
fn iso_source_requires_an_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("not-a-disc.iso");
    std::fs::write(&file, b"junk").unwrap();

    let ok = DiscSource::parse("iso", file.to_str().unwrap()).expect("存在的文件可通过");
    assert!(matches!(ok.kind, SourceKind::Iso(_)));

    // 目录不能当 iso。
    assert!(DiscSource::parse("iso", dir.path().to_str().unwrap()).is_err());
    // 不存在的路径。
    assert!(DiscSource::parse("iso", dir.path().join("nope.iso").to_str().unwrap()).is_err());
    // 空路径。
    assert!(DiscSource::parse("iso", "   ").is_err());
    // 未知 kind。
    assert!(DiscSource::parse("tape", file.to_str().unwrap()).is_err());
}

#[test]
fn folder_source_requires_a_directory() {
    let dir = tempfile::tempdir().unwrap();
    let ok = DiscSource::parse("folder", dir.path().to_str().unwrap()).expect("存在的目录可通过");
    assert!(matches!(ok.kind, SourceKind::Folder(_)));
    let file = dir.path().join("not-a-disc.iso");
    std::fs::write(&file, b"junk").unwrap();
    assert!(DiscSource::parse("folder", file.to_str().unwrap()).is_err());
}

#[test]
fn drive_source_preserves_upstream_device_path() {
    // 设备路径原样交给上游 DiscSession；不在侧车伪造或改写设备标识。
    let src = DiscSource::parse("drive", "\\\\.\\CdRom0").expect("drive 参数可通过");
    assert!(matches!(src.kind, SourceKind::Drive(_)));
    assert_eq!(src.path().to_str().unwrap(), "\\\\.\\CdRom0");
}

#[test]
fn track_id_encoding_is_stable() {
    // 三态选轨由 TrackChoice 负责；这里只固定 TrackId 的编码契约。
    let all = TrackId {
        index: 0,
        pid: 0x1100,
        language: Some("eng".into()),
    };
    let encoded = all.encode();
    assert!(encoded.starts_with("s0:"));
    assert!(encoded.ends_with(":eng"));
}

#[test]
fn error_codes_are_namespaced() {
    for code in [
        errors::ERR_PROTOCOL_JSON,
        errors::ERR_PROTOCOL_VERSION,
        errors::ERR_SOURCE_KIND,
        errors::ERR_OUTPUT_EXISTS,
        errors::ERR_TRACK_IDS,
        errors::ERR_TITLE_UNKNOWN,
        errors::ERR_TITLE_MISMATCH,
        errors::ERR_UNSUPPORTED,
        errors::ERR_CANCELLED,
    ] {
        assert!(code.starts_with("FFGUI_"), "{code} 必须是 FFGUI_ 前缀");
    }
}

#[test]
fn error_params_carry_machine_readable_fields() {
    let p = errors::params(&[("feature", serde_json::json!("drive"))]);
    assert_eq!(p["feature"], "drive");
}
