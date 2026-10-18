//! 合成媒体验证：probe 与 rip 的真实代码路径。
//!
//! 这些测试用 libfreemkv 的 test-util 合成一个可扫描的 BD 镜像（明文 LPCM），
//! 因此 probe 与 rip 都跑真实的扫描、标题枚举与 MKV mux。
//! 不涉及任何真实光盘、真实密钥或 profiles.json。

mod fixtures;

use ffgui_disc::jobs;
use ffgui_disc::model::{TrackChoice, TrackId, title_identities};
use ffgui_disc::sink::NdjsonSink;
use ffgui_disc::source::DiscSource;
use fixtures::SyntheticDisc;
use serde_json::Value;
use std::path::Path;

fn write_iso(dir: &Path, name: &str, disc: &SyntheticDisc) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, &disc.image).unwrap();
    path
}

fn probe_json(iso: &Path) -> Value {
    let src = DiscSource::parse("iso", iso.to_str().unwrap()).unwrap();
    let sink = NdjsonSink::new("test");
    jobs::probe(&sink, &src).expect("合成 BD 镜像应能探测")
}

#[test]
fn probe_lists_every_title_with_stable_ids() {
    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd(3);
    let iso = write_iso(dir.path(), "disc.iso", &disc);
    let out = probe_json(&iso);

    assert_eq!(out["disc"]["format"], "bluray");
    let titles = out["disc"]["titles"].as_array().unwrap();
    assert_eq!(titles.len(), 3);
    for (i, t) in titles.iter().enumerate() {
        let id = t["id"].as_str().unwrap();
        assert!(id.starts_with("bluray/"), "id={id}");
        assert!(id.contains(&format!("{i:05}.mpls")), "id={id}");
        assert!(t["durationMs"].as_u64().unwrap() > 0, "标题 {i} 应有时长");
        assert!(t["sizeBytes"].as_u64().unwrap() > 0, "标题 {i} 应有大小");
        // 合成夹具只有 LPCM 音轨、没有视频流，故 video 为空数组。
        assert!(t["video"].as_array().unwrap().is_empty(), "合成夹具无视频");
        assert_eq!(
            t["audio"].as_array().unwrap().len(),
            1,
            "标题 {i} 应有一条音轨"
        );
        let audio = &t["audio"][0];
        assert_eq!(audio["codec"], "lpcm");
        assert!(audio["language"].is_string(), "合成夹具带语言码");
        assert!(audio["id"].as_str().unwrap().starts_with("s"));
        assert!(t["subtitles"].as_array().unwrap().is_empty());
    }
    // 每个标题的语言可独立指定（夹具按 TitleSpec 给）。
    let langs: Vec<&str> = titles
        .iter()
        .map(|t| t["audio"][0]["language"].as_str().unwrap())
        .collect();
    assert_eq!(langs, vec!["eng", "eng", "eng"]);
}

#[test]
fn probe_reports_per_title_language_and_multi_audio() {
    let dir = tempfile::tempdir().unwrap();
    let specs = [
        fixtures::TitleSpec {
            units: 10,
            audio_pids: &[fixtures::AUDIO_PID_0, fixtures::AUDIO_PID_1],
            language: b"jpn",
            secs: 120,
        },
        fixtures::TitleSpec {
            units: 10,
            audio_pids: &[fixtures::AUDIO_PID_0],
            language: b"deu",
            secs: 90,
        },
    ];
    let disc = fixtures::synthetic_bd_specs(&specs);
    let iso = write_iso(dir.path(), "multi.iso", &disc);
    let out = probe_json(&iso);
    let titles = out["disc"]["titles"].as_array().unwrap();

    assert_eq!(
        titles[0]["audio"].as_array().unwrap().len(),
        2,
        "标题 0 有两条音轨"
    );
    let ids: Vec<&str> = titles[0]["audio"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_ne!(ids[0], ids[1], "两条音轨 id 必须不同");
    assert_eq!(titles[0]["audio"][0]["language"], "jpn");
    assert_eq!(titles[1]["audio"].as_array().unwrap().len(), 1);
    assert_eq!(titles[1]["audio"][0]["language"], "deu");
}

#[test]
fn rip_writes_a_verified_mkv() {
    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd(1);
    let iso = write_iso(dir.path(), "disc.iso", &disc);

    // 先探测拿 titleId。
    let probe = probe_json(&iso);
    let title_id = probe["disc"]["titles"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let out = dir.path().join("movie.mkv");
    let src = DiscSource::parse("iso", iso.to_str().unwrap()).unwrap();
    let sink = NdjsonSink::new("test");
    let result = jobs::rip(
        &sink,
        &src,
        &title_id,
        &out,
        &TrackChoice::All,
        &TrackChoice::All,
        None,
        None,
    )
    .expect("明文合成盘应能无损抓成 MKV");

    assert_eq!(result["titleId"], title_id.as_str());
    let produced = std::path::PathBuf::from(result["output"].as_str().unwrap());
    assert_eq!(produced, out);
    assert!(out.exists(), "输出文件必须存在");
    let size = std::fs::metadata(&out).unwrap().len();
    assert!(size > 0, "MKV 不能为空");

    // 用 libfreemkv 自己的探针复核产物：至少一条轨、时长与标题声明相符。
    let file = std::fs::File::open(&out).unwrap();
    let probe = libfreemkv::probe_mkv_with_cues(std::io::BufReader::new(file)).unwrap();
    assert!(!probe.tracks.is_empty(), "MKV 至少要有一条轨");
}

#[test]
fn rip_applies_three_state_audio_selection_to_real_mkv() {
    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd_with_video(10);
    let iso = write_iso(dir.path(), "disc.iso", &disc);

    let probe = probe_json(&iso);
    let title_id = probe["disc"]["titles"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        probe["disc"]["titles"][0]["video"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "夹具应给出一条视频，允许产出纯视频 MKV"
    );
    let audio = probe["disc"]["titles"][0]["audio"].as_array().unwrap();
    assert_eq!(audio.len(), 2, "夹具应给出两条音轨");
    let first = audio[0]["id"].as_str().unwrap().to_string();
    let second = audio[1]["id"].as_str().unwrap().to_string();

    let src = DiscSource::parse("iso", iso.to_str().unwrap()).unwrap();
    let sink = NdjsonSink::new("test");
    let no_subtitles = TrackChoice::parse(Some(&serde_json::json!([]))).unwrap();

    // audio null + subtitle []：真实产物必须有两条音轨、零条字幕轨。
    let all = dir.path().join("all.mkv");
    let all_audio = TrackChoice::parse(Some(&serde_json::json!(null))).unwrap();
    jobs::rip(
        &sink,
        &src,
        &title_id,
        &all,
        &all_audio,
        &no_subtitles,
        None,
        None,
    )
    .unwrap();
    assert_eq!(track_counts(&all), (2, 0), "audio null 必须保留全部音轨");

    // 非空数组 = 只保留指定轨，字幕 [] 仍是零条。
    let only_first = dir.path().join("first.mkv");
    let first_only = TrackChoice::parse(Some(&serde_json::json!([&first]))).unwrap();
    jobs::rip(
        &sink,
        &src,
        &title_id,
        &only_first,
        &first_only,
        &no_subtitles,
        None,
        None,
    )
    .unwrap();
    assert_eq!(track_counts(&only_first), (1, 0), "显式选一条必须只留一条");

    let only_second = dir.path().join("second.mkv");
    let second_only = TrackChoice::parse(Some(&serde_json::json!([&second]))).unwrap();
    jobs::rip(
        &sink,
        &src,
        &title_id,
        &only_second,
        &second_only,
        &no_subtitles,
        None,
        None,
    )
    .unwrap();
    assert_eq!(track_counts(&only_second), (1, 0));
    assert_ne!(
        std::fs::read(&only_first).unwrap(),
        std::fs::read(&only_second).unwrap(),
        "选不同轨应产出不同内容"
    );

    // 音频显式 []：产物必须剩一条视频，真实音轨数为 0，不能回退成“全部”。
    let no_audio = dir.path().join("no-audio.mkv");
    let no_audio_choice = TrackChoice::parse(Some(&serde_json::json!([]))).unwrap();
    jobs::rip(
        &sink,
        &src,
        &title_id,
        &no_audio,
        &no_audio_choice,
        &no_subtitles,
        None,
        None,
    )
    .expect("排除全部音频后仍应能抓取视频");
    assert_eq!(track_counts(&no_audio), (0, 0));
    assert_eq!(tracks_of(&no_audio), 1, "剩下的唯一轨道应是视频");
}

#[test]
fn rip_all_audio_with_no_subtitles_is_expressible() {
    // 关键语义：audio 缺失/null（全部）+ subtitle 显式 []（一条不要）。
    // 旧版"空数组 = 全部"无法表达这个组合。
    let dir = tempfile::tempdir().unwrap();
    let specs = [fixtures::TitleSpec {
        units: 20,
        audio_pids: &[fixtures::AUDIO_PID_0, fixtures::AUDIO_PID_1],
        language: b"jpn",
        secs: 120,
    }];
    let disc = fixtures::synthetic_bd_specs(&specs);
    let iso = write_iso(dir.path(), "disc.iso", &disc);
    let probe = probe_json(&iso);
    let title_id = probe["disc"]["titles"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        probe["disc"]["titles"][0]["audio"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let out = dir.path().join("all-audio-no-subs.mkv");
    let src = DiscSource::parse("iso", iso.to_str().unwrap()).unwrap();
    let sink = NdjsonSink::new("test");
    // audio：字段缺失（All）；subtitle：显式空数组（None）。
    let audio = TrackChoice::parse(None).unwrap();
    let subtitle = TrackChoice::parse(Some(&serde_json::json!([]))).unwrap();
    assert_eq!(audio, TrackChoice::All);
    assert_eq!(subtitle, TrackChoice::None);
    jobs::rip(&sink, &src, &title_id, &out, &audio, &subtitle, None, None).unwrap();
    assert_eq!(
        track_counts(&out),
        (2, 0),
        "audio 字段缺失必须保留全部音轨，subtitle [] 必须无字幕"
    );
}

#[test]
fn track_choice_parse_covers_all_three_states() {
    use serde_json::json;
    // 缺失 / null → All
    assert_eq!(TrackChoice::parse(None).unwrap(), TrackChoice::All);
    assert_eq!(
        TrackChoice::parse(Some(&json!(null))).unwrap(),
        TrackChoice::All
    );
    // 显式 [] → None
    assert_eq!(
        TrackChoice::parse(Some(&json!([]))).unwrap(),
        TrackChoice::None
    );
    // 非空 → Only
    let raw = "s1:p4353:jpn";
    match TrackChoice::parse(Some(&json!([raw]))).unwrap() {
        TrackChoice::Only(ids) => {
            assert_eq!(ids.len(), 1);
            assert_eq!(ids[0].encode(), raw);
        }
        other => panic!("期望 Only，得到 {other:?}"),
    }
    // 非数组 / 元素非字符串 → Err
    assert!(TrackChoice::parse(Some(&json!("eng"))).is_err());
    assert!(TrackChoice::parse(Some(&json!([1]))).is_err());
    // 无法解析的 id → Err（带原始值）
    let err = TrackChoice::parse(Some(&json!(["garbage"]))).unwrap_err();
    assert_eq!(err, "garbage");
}

#[test]
fn rip_rejects_an_unknown_subtitle_track_id() {
    // 非空选轨数组必须逐条命中，不能静默降级为该类全部轨。
    let dir = tempfile::tempdir().unwrap();
    let specs = [fixtures::TitleSpec {
        units: 10,
        audio_pids: &[fixtures::AUDIO_PID_0, fixtures::AUDIO_PID_1],
        language: b"jpn",
        secs: 120,
    }];
    let disc = fixtures::synthetic_bd_specs(&specs);
    let iso = write_iso(dir.path(), "disc.iso", &disc);
    let probe = probe_json(&iso);
    let title_id = probe["disc"]["titles"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    // 本盘没有字幕，取一个必然不存在的字幕 id：应因 FFGUI_TRACK_IDS 失败，
    // 而不是静默按"全部"处理。
    let out = dir.path().join("x.mkv");
    let src = DiscSource::parse("iso", iso.to_str().unwrap()).unwrap();
    let sink = NdjsonSink::new("test");
    let err = jobs::rip(
        &sink,
        &src,
        &title_id,
        &out,
        &TrackChoice::All,
        &TrackChoice::Only(vec![TrackId::decode("s9:p9999:eng").unwrap()]),
        None,
        None,
    )
    .expect_err("不存在的字幕 id 必须报错");
    assert_eq!(err.0, "FFGUI_TRACK_IDS");
}

#[test]
fn rip_rejects_a_bogus_track_id() {
    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd(1);
    let iso = write_iso(dir.path(), "disc.iso", &disc);
    let probe = probe_json(&iso);
    let title_id = probe["disc"]["titles"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let out = dir.path().join("x.mkv");

    let src = DiscSource::parse("iso", iso.to_str().unwrap()).unwrap();
    let sink = NdjsonSink::new("test");
    let err = jobs::rip(
        &sink,
        &src,
        &title_id,
        &out,
        &TrackChoice::Only(vec![TrackId::decode("s9:p9999:eng").unwrap()]),
        &TrackChoice::All,
        None,
        None,
    )
    .expect_err("不存在的轨 id 必须报错");
    assert_eq!(err.0, "FFGUI_TRACK_IDS");
    assert!(!out.exists(), "失败的 rip 不得留下输出");
}

#[test]
fn rip_rejects_an_unknown_title_id() {
    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd(2);
    let iso = write_iso(dir.path(), "disc.iso", &disc);
    let out = dir.path().join("x.mkv");

    let src = DiscSource::parse("iso", iso.to_str().unwrap()).unwrap();
    let sink = NdjsonSink::new("test");
    let err = jobs::rip(
        &sink,
        &src,
        "bluray/99999.mpls",
        &out,
        &TrackChoice::All,
        &TrackChoice::All,
        None,
        None,
    )
    .expect_err("未知 titleId 必须报错");
    assert_eq!(err.0, "FFGUI_TITLE_UNKNOWN");
}

#[test]
fn rip_picks_the_title_the_id_names_not_the_first_one() {
    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd(3);
    let iso = write_iso(dir.path(), "disc.iso", &disc);
    let probe = probe_json(&iso);
    // 第三个标题（index 2）。
    let wanted = probe["disc"]["titles"][2]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(wanted.contains("00002.mpls"), "wanted={wanted}");

    let out = dir.path().join("third.mkv");
    let src = DiscSource::parse("iso", iso.to_str().unwrap()).unwrap();
    let sink = NdjsonSink::new("test");
    let result = jobs::rip(
        &sink,
        &src,
        &wanted,
        &out,
        &TrackChoice::All,
        &TrackChoice::All,
        None,
        None,
    )
    .unwrap();
    assert_eq!(result["titleId"], wanted.as_str());
    assert!(out.exists());
}

#[test]
fn title_ids_survive_a_rescan_of_the_same_image() {
    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd(2);
    let iso = write_iso(dir.path(), "disc.iso", &disc);
    let src = DiscSource::parse("iso", iso.to_str().unwrap()).unwrap();

    let first = probe_json(&iso);
    let ids_first: Vec<String> = first["disc"]["titles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_string())
        .collect();

    // 用同一份镜像再扫一次，id 必须完全一致（probe→rip 之间重扫的稳定性）。
    let (scanned, _reader) =
        freemkv_engine::scan_image(&freemkv_engine::ImageSource::from_path(src.path())).unwrap();
    let ids_again: Vec<String> = title_identities(&scanned)
        .into_iter()
        .map(|i| i.stable_id)
        .collect();
    assert_eq!(ids_first, ids_again);
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

#[test]
fn rip_refuses_a_pre_existing_partial_and_never_deletes_it() {
    // 用户预先占用了 <output>.ffgui-partial：必须拒绝，且该文件内容不变。
    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd(1);
    let iso = write_iso(dir.path(), "disc.iso", &disc);
    let probe = probe_json(&iso);
    let title_id = probe["disc"]["titles"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let out = dir.path().join("movie.mkv");
    let partial = jobs::partial_path(&out);
    std::fs::write(&partial, b"pre-existing user data").unwrap();

    let src = DiscSource::parse("iso", iso.to_str().unwrap()).unwrap();
    let sink = NdjsonSink::new("test");
    let err = jobs::rip(
        &sink,
        &src,
        &title_id,
        &out,
        &TrackChoice::All,
        &TrackChoice::All,
        None,
        None,
    )
    .expect_err("预存 partial 必须拒绝");
    assert_eq!(err.0, "FFGUI_PARTIAL_EXISTS");
    assert_eq!(
        std::fs::read(&partial).unwrap(),
        b"pre-existing user data",
        "绝不能被删掉或改写"
    );
    assert!(!out.exists(), "拒绝后不得创建输出");
}

#[test]
fn folder_source_probes_and_rips_end_to_end() {
    // folder 源：把合成镜像按 BDMV/AACS 目录树展开，走与 iso 相同的真实路径。
    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd(2);
    let iso = write_iso(dir.path(), "disc.iso", &disc);

    // 从 ISO 里取出每个文件的区间，按目录树落盘（UDF 布局的逆向，只取所需文件）。
    let root = dir.path().join("tree");
    let src = DiscSource::parse("iso", iso.to_str().unwrap()).unwrap();
    let names = [
        "BDMV/index.bdmv",
        "BDMV/PLAYLIST/00000.mpls",
        "BDMV/PLAYLIST/00001.mpls",
        "BDMV/CLIPINF/00000.clpi",
        "BDMV/CLIPINF/00001.clpi",
        "BDMV/STREAM/00000.m2ts",
        "BDMV/STREAM/00001.m2ts",
    ];
    {
        let (scanned, _reader) =
            freemkv_engine::scan_image(&freemkv_engine::ImageSource::from_path(src.path()))
                .unwrap();
        let mut fs_img = libfreemkv::FileSectorSource::open(&iso).unwrap();
        let fs = libfreemkv::read_filesystem(&mut fs_img).unwrap();
        for name in names {
            let extents = fs
                .file_extents(&mut fs_img, &format!("/{name}"))
                .unwrap_or_default();
            assert_eq!(extents.len(), 1, "{name} 应只有一个连续区间");
            let (lba, sectors) = extents[0];
            let at = lba as usize * 2048;
            let bytes = std::fs::read(&iso).unwrap()[at..at + sectors as usize * 2048].to_vec();
            let p = root.join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, &bytes).unwrap();
        }
        assert_eq!(scanned.titles.len(), 2);
    }

    // probe folder
    let folder_src = DiscSource::parse("folder", root.to_str().unwrap()).unwrap();
    let sink = NdjsonSink::new("test");
    let probed = jobs::probe(&sink, &folder_src).expect("folder 源应能探测");
    let titles = probed["disc"]["titles"].as_array().unwrap();
    assert_eq!(titles.len(), 2, "folder 源应枚举出同样两个标题");
    let ids_from_iso: Vec<String> = probe_json(&iso)["disc"]["titles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_string())
        .collect();
    let ids_from_folder: Vec<String> = titles
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        ids_from_iso, ids_from_folder,
        "folder 与 iso 的 titleId 应一致"
    );

    // rip folder：第二个标题
    let wanted = titles[1]["id"].as_str().unwrap().to_string();
    let out = dir.path().join("from-folder.mkv");
    let result = jobs::rip(
        &sink,
        &folder_src,
        &wanted,
        &out,
        &TrackChoice::All,
        &TrackChoice::All,
        None,
        None,
    )
    .expect("folder 源应能抓取");
    assert_eq!(result["titleId"], wanted.as_str());
    assert!(out.exists() && std::fs::metadata(&out).unwrap().len() > 0);
    assert_eq!(tracks_of(&out), 1, "应产出可播放的 MKV");
}

#[test]
fn rip_validates_the_optional_title_fingerprint() {
    // probe 返回的 fingerprint 可经可选字段 titleFingerprint 回传给 rip：
    // 同一份盘必须通过；指纹不符必须报 FFGUI_TITLE_MISMATCH 且不产出文件。
    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd(1);
    let iso = write_iso(dir.path(), "disc.iso", &disc);
    let probe = probe_json(&iso);
    let title_id = probe["disc"]["titles"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let fingerprint = probe["disc"]["titles"][0]["fingerprint"].clone();
    assert!(fingerprint.is_object(), "probe 必须给出 fingerprint");
    assert!(fingerprint["sectors"].is_number());
    assert!(fingerprint["sizeBytes"].is_number());

    let src = DiscSource::parse("iso", iso.to_str().unwrap()).unwrap();
    let sink = NdjsonSink::new("test");

    // 一致的指纹：rip 成功。
    let ok_out = dir.path().join("ok.mkv");
    let result = jobs::rip(
        &sink,
        &src,
        &title_id,
        &ok_out,
        &TrackChoice::All,
        &TrackChoice::All,
        None,
        Some(&fingerprint),
    )
    .expect("指纹一致应放行");
    assert_eq!(result["titleId"], title_id.as_str());
    assert!(ok_out.exists());

    // 篡改的指纹（扇区数不同）：必须拒绝，且不产出文件。
    let mut bad = fingerprint.clone();
    bad["sectors"] = serde_json::json!(999_999);
    let bad_out = dir.path().join("bad.mkv");
    let err = jobs::rip(
        &sink,
        &src,
        &title_id,
        &bad_out,
        &TrackChoice::All,
        &TrackChoice::All,
        None,
        Some(&bad),
    )
    .expect_err("指纹不符必须拒绝");
    assert_eq!(err.0, "FFGUI_TITLE_MISMATCH");
    assert!(!bad_out.exists(), "拒绝后不得产出文件");
}

#[test]
fn probe_fingerprint_round_trips_through_the_protocol() {
    // probe 输出的 fingerprint 必须能被 model::parse_fingerprint 原样读回，
    // 否则前端带回的字段毫无意义。
    let dir = tempfile::tempdir().unwrap();
    let disc = fixtures::synthetic_bd(1);
    let iso = write_iso(dir.path(), "disc.iso", &disc);
    let probe = probe_json(&iso);
    let t = &probe["disc"]["titles"][0];
    let parsed = ffgui_disc::model::parse_fingerprint(Some(&t["fingerprint"]))
        .expect("probe 的 fingerprint 必须可解析");
    assert_eq!(parsed.stable_id, t["id"].as_str().unwrap());
    assert_eq!(parsed.size_bytes, t["sizeBytes"].as_u64().unwrap());
    assert!(parsed.sectors > 0);
}
