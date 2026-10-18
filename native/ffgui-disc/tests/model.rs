//! 标题/轨道稳定标识与映射的单元测试（无真实媒体验证，纯结构映射）。

use ffgui_disc::model::{
    TitleLookup, TrackId, find_title, format_id, language_of, stream_id_of, title_identities,
};
use freemkv_engine::{Disc, DiscFormat, Stream};
use libfreemkv::disc::{Chapter, DiscRegion};
use libfreemkv::{
    AudioChannels, AudioStream, Codec, ColorSpace, ContentFormat, DiscTitle, Extent, FrameRate,
    HdrFormat, LabelPurpose, LabelQualifier, Resolution, SampleRate, SubtitleStream, VideoStream,
};

fn disc(playlists: &[(&str, u16, f64, u32, u32)]) -> Disc {
    Disc {
        volume_id: "TEST_DISC".into(),
        meta_title: Some("测试光盘".into()),
        format: DiscFormat::BluRay,
        capacity_sectors: 1_000_000,
        capacity_bytes: 1_000_000 * 2048,
        layers: 1,
        titles: playlists
            .iter()
            .map(|&(name, id, dur, lba, sectors)| {
                title(
                    name,
                    id,
                    dur,
                    Extent {
                        start_lba: lba,
                        sector_count: sectors,
                    },
                )
            })
            .collect(),
        region: DiscRegion::Unknown,
        aacs: None,
        css: None,
        encrypted: false,
        aacs_error: None,
        css_error: None,
        content_format: ContentFormat::BdTs,
    }
}

fn title(playlist: &str, id: u16, dur: f64, extent: Extent) -> DiscTitle {
    DiscTitle {
        selection_evidence: Default::default(),
        playlist: playlist.to_string(),
        playlist_id: id,
        duration_secs: dur,
        size_bytes: u64::from(extent.sector_count) * 2048,
        clips: Vec::new(),
        streams: vec![
            Stream::Video(VideoStream {
                pid: 0x1011,
                codec: Codec::H264,
                resolution: Resolution::R1080p,
                frame_rate: FrameRate::F24,
                hdr: HdrFormat::Sdr,
                color_space: ColorSpace::Bt709,
                display_aspect: None,
                secondary: false,
                label: String::new(),
                measured_cicp: None,
            }),
            Stream::Audio(AudioStream {
                pid: 0x1100,
                codec: Codec::TrueHd,
                channels: AudioChannels::Surround51,
                language: "jpn".into(),
                sample_rate: SampleRate::S48,
                secondary: false,
                purpose: LabelPurpose::Normal,
                label: "Dolby TrueHD 5.1".into(),
            }),
            Stream::Audio(AudioStream {
                pid: 0x1101,
                codec: Codec::Ac3,
                channels: AudioChannels::Surround51,
                language: String::new(),
                sample_rate: SampleRate::S48,
                secondary: false,
                purpose: LabelPurpose::Normal,
                label: String::new(),
            }),
            Stream::Subtitle(SubtitleStream {
                pid: 0x1200,
                codec: Codec::Pgs,
                language: "chi".into(),
                forced: false,
                qualifier: LabelQualifier::None,
                codec_data: None,
            }),
        ],
        chapters: vec![Chapter {
            time_secs: 0.0,
            name: "1".into(),
        }],
        extents: vec![extent],
        content_format: ContentFormat::BdTs,
        codec_privates: Vec::new(),
    }
}

fn sample() -> Disc {
    disc(&[
        ("00800.mpls", 800, 100.0, 4096, 200),
        ("00001.mpls", 1, 50.0, 900_000, 60),
    ])
}

#[test]
fn title_ids_use_playlist_names_not_indices() {
    let ids = title_identities(&sample());
    let names: Vec<&str> = ids.iter().map(|i| i.stable_id.as_str()).collect();
    assert!(names.contains(&"bluray/00800.mpls"));
    assert!(names.contains(&"bluray/00001.mpls"));
    for name in &names {
        assert!(
            !name.contains("index"),
            "titleId 不得伪装成数组下标: {name}"
        );
    }
}

#[test]
fn title_ids_are_stable_under_reordering() {
    let mut shuffled = sample();
    shuffled.titles.reverse();
    let before = title_identities(&sample());
    let after = title_identities(&shuffled);
    for id in &before {
        assert!(after.iter().any(|o| o.stable_id == id.stable_id));
    }
}

#[test]
fn identical_playlists_get_disambiguating_suffix() {
    let mut d = sample();
    d.titles.push(title(
        "00800.mpls",
        800,
        100.0,
        Extent {
            start_lba: 500_000,
            sector_count: 200,
        },
    ));
    let ids = title_identities(&d);
    let dupes: Vec<&String> = ids
        .iter()
        .map(|i| &i.stable_id)
        .filter(|s| s.contains("00800.mpls"))
        .collect();
    assert_eq!(dupes.len(), 2);
    assert!(dupes.iter().any(|s| s.ends_with("#1")));
    assert!(dupes.iter().any(|s| s.ends_with("#2")));
}

#[test]
fn find_title_accepts_matching_fingerprint() {
    let d = sample();
    let ids = title_identities(&d);
    let idx = find_title(&d, "bluray/00800.mpls", Some(&ids[0])).expect("命中");
    assert_eq!(idx, 0);
}

#[test]
fn find_title_without_a_fingerprint_only_matches_the_persistent_id() {
    // 没带指纹 = 只按持久标识定位，不做内容校验（前端未回传时的行为）。
    let d = sample();
    let idx = find_title(&d, "bluray/00800.mpls", None).expect("命中");
    assert_eq!(idx, 0);
}

#[test]
fn find_title_rejects_unknown_id() {
    let d = sample();
    assert!(find_title(&d, "bluray/99999.mpls", None).is_err());
}

#[test]
fn find_title_rejects_content_mismatch() {
    // 模拟「probe 之后盘被换掉」：持久标识（playlist 名）相同，但内容扇区不同。
    let before = sample();
    let stale = title_identities(&before);
    let mut other = sample();
    let swapped = Extent {
        start_lba: 123_456,
        sector_count: 999,
    };
    other.titles[0].extents = vec![swapped];
    other.titles[0].size_bytes = u64::from(swapped.sector_count) * 2048;
    let err =
        find_title(&other, "bluray/00800.mpls", Some(&stale[0])).expect_err("内容不一致必须报错");
    assert!(matches!(err, TitleLookup::Mismatch { .. }));
}

#[test]
fn language_is_null_when_unknown() {
    assert_eq!(language_of(""), None);
    assert_eq!(language_of("  "), None);
    assert_eq!(language_of("ENG"), Some("eng".to_string()));
}

#[test]
fn track_ids_round_trip() {
    let t = TrackId {
        index: 3,
        pid: 0x1100,
        language: Some("jpn".into()),
    };
    assert_eq!(TrackId::decode(&t.encode()), Some(t));
    let und = TrackId {
        index: 0,
        pid: 0,
        language: None,
    };
    assert_eq!(TrackId::decode(&und.encode()), Some(und));
}

#[test]
fn track_id_decode_rejects_garbage() {
    assert!(TrackId::decode("").is_none());
    assert!(TrackId::decode("3:0x1100:jpn").is_none());
    assert!(TrackId::decode("x1:p1:und").is_none());
}

#[test]
fn stream_ids_match_probe_view() {
    let title = &sample().titles[0];
    assert_eq!(stream_id_of(&title.streams[1], 1), "s1:p4352:jpn");
    assert_eq!(stream_id_of(&title.streams[2], 2), "s2:p4353:und");
    assert_eq!(stream_id_of(&title.streams[0], 0), "s0:p4113:und");
}

#[test]
fn format_ids_are_stable_strings() {
    assert_eq!(format_id(DiscFormat::Dvd), "dvd");
    assert_eq!(format_id(DiscFormat::BluRay), "bluray");
    assert_eq!(format_id(DiscFormat::Uhd), "uhd");
    assert_eq!(format_id(DiscFormat::HdDvd), "hddvd");
    assert_eq!(format_id(DiscFormat::Fmts), "fmts");
    assert_eq!(format_id(DiscFormat::Unknown), "unknown");
}

#[test]
fn identity_fingerprint_tracks_extents() {
    let ids = title_identities(&sample());
    let main = ids
        .iter()
        .find(|i| i.stable_id == "bluray/00800.mpls")
        .unwrap();
    assert_eq!(main.first_lba, Some(4096));
    assert_eq!(main.sectors, 200);
    assert_eq!(main.size_bytes, 200 * 2048);
}
