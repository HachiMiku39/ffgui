//! 合成 BD 镜像的构造器：复刻 libfreemkv / freemkv-engine 测试夹具的做法，
//! 用一个可扫描的 `BDMV/` + `AACS/` 镜像跑 probe 与 rip 的真实代码路径。
//!
//! 这是**合成媒体**验证：不含任何真实光盘的密钥或 profiles.json。
//! 默认夹具是 BD LPCM；选轨夹具另用上游的 MPEG-2 视频 + 双 AC-3 媒体。

use libfreemkv::aacs::mkb::AacsVersion;
use libfreemkv::test_util::{BdFile, encrypted_bd_image, synthetic_bd_clip};

/// 默认每条 clip 的 aligned unit 数（每个 6144 字节 = 32 个 TS 包）。
const DEFAULT_CLIP_UNITS: u32 = 10;
/// 第一条 LPCM 音轨的 PID。
pub const AUDIO_PID_0: u16 = 0x1100;
/// 第二条 LPCM 音轨的 PID（用于选轨测试）。
#[allow(dead_code)] // fixtures 模块按集成测试分别编译，并非每个测试 crate 都使用双 LPCM。
pub const AUDIO_PID_1: u16 = 0x1101;
/// 默认每个标题的秒数。
const TITLE_SECS: u32 = 120;

/// 一个 5 字节 clip 名（"00000"）。
fn clip_id(i: usize) -> [u8; 5] {
    format!("{i:05}").as_bytes().try_into().unwrap()
}

/// MPLS 的 STN：可选一条 MPEG-2 视频，随后是 `audio_pids` 声明的音频。
fn stn_streams(
    audio_pids: &[u16],
    language: &[u8; 3],
    audio_coding_type: u8,
    video_pid: Option<u16>,
) -> Vec<u8> {
    let mut stn = vec![0u8; 16];
    if let Some(pid) = video_pid {
        stn[4] = 1;
        stn.extend_from_slice(&[3, 0x01]);
        stn.extend_from_slice(&pid.to_be_bytes());
        stn.extend_from_slice(&[2, 0x02, 0x10]);
    }
    stn[5] = audio_pids.len() as u8;
    for (i, pid) in audio_pids.iter().enumerate() {
        stn.extend_from_slice(&[3, 0x01]);
        stn.extend_from_slice(&pid.to_be_bytes());
        stn.extend_from_slice(&[5, audio_coding_type, 0x31]);
        stn.extend_from_slice(if i == 0 { language } else { b"eng" });
    }
    stn
}

/// 单 PlayItem 的 LPCM MPLS。
fn one_item_mpls(clip: [u8; 5], audio_pids: &[u16], language: &[u8; 3], secs: u32) -> Vec<u8> {
    one_item_mpls_streams(clip, audio_pids, language, secs, 0x80, None)
}

/// 单 PlayItem 的 MPEG-2 + AC-3 MPLS。
fn one_item_mpls_with_video(
    clip: [u8; 5],
    audio_pids: &[u16],
    language: &[u8; 3],
    secs: u32,
    video_pid: u16,
) -> Vec<u8> {
    one_item_mpls_streams(clip, audio_pids, language, secs, 0x81, Some(video_pid))
}

#[allow(clippy::too_many_arguments)]
fn one_item_mpls_streams(
    clip: [u8; 5],
    audio_pids: &[u16],
    language: &[u8; 3],
    secs: u32,
    audio_coding_type: u8,
    video_pid: Option<u16>,
) -> Vec<u8> {
    let mut pl = vec![0u8; 6];
    pl.extend_from_slice(&1u16.to_be_bytes());
    pl.extend_from_slice(&[0u8; 2]);
    let mut item = clip.to_vec();
    item.extend_from_slice(b"M2TS");
    item.extend_from_slice(&[0u8; 3]);
    item.extend_from_slice(&45_000u32.to_be_bytes());
    item.extend_from_slice(&(45_000 * (1 + secs)).to_be_bytes());
    item.extend_from_slice(&[0u8; 12]);
    item.extend_from_slice(&stn_streams(
        audio_pids,
        language,
        audio_coding_type,
        video_pid,
    ));
    pl.extend_from_slice(&(item.len() as u16).to_be_bytes());
    pl.extend_from_slice(&item);
    let pl_len = (pl.len() - 4) as u32;
    pl[0..4].copy_from_slice(&pl_len.to_be_bytes());
    let mut buf = b"MPLS0200".to_vec();
    buf.extend_from_slice(&58u32.to_be_bytes());
    buf.extend_from_slice(&[0u8; 28]);
    buf.extend_from_slice(&14u32.to_be_bytes());
    buf.extend_from_slice(&[0, 1]);
    buf.extend_from_slice(&[0u8; 12]);
    buf.extend_from_slice(&pl);
    buf
}

/// 只有 magic 和 source packet 数的最小 CLPI。
fn minimal_clpi(source_packets: u32) -> Vec<u8> {
    let mut d = vec![0u8; 60];
    d[0..4].copy_from_slice(b"HDMV");
    d[4..8].copy_from_slice(b"0200");
    d[56..60].copy_from_slice(&source_packets.to_be_bytes());
    d
}

/// 源包 `k`/`n`：TP_extra_header + 一整个 LPCM PES 的 TS 包。
/// `pid` 是该包的 TS PID；`seq` 让同一 PES 序号在不同轨间字节可区分。
fn lpcm_source_packet(k: u32, n: u32, pid: u16, encrypted: bool, seq: u8) -> [u8; 192] {
    const AUDIO: usize = 160;
    let mut p = [0u8; 192];
    p[..4].copy_from_slice(&(k * 100).to_be_bytes());
    p[0] = if encrypted { p[0] | 0xC0 } else { p[0] & 0x3F };
    let ts = &mut p[4..];
    ts[..4].copy_from_slice(&[0x47, 0x40 | (pid >> 8) as u8, pid as u8, 0x30]);
    ts[3] |= (k & 0x0F) as u8;
    let stuffing = 188 - 4 - 1 - (14 + 4 + AUDIO);
    ts[4] = stuffing as u8;
    ts[5] = 0x00;
    ts[6..5 + stuffing].fill(0xFF);
    let pts = 90_000u64 + u64::from(k) * 90_000 * u64::from(TITLE_SECS) / u64::from(n);
    let pes = &mut ts[5 + stuffing..];
    pes[..4].copy_from_slice(&[0, 0, 1, 0xBD]);
    pes[4..6].copy_from_slice(&((8 + 4 + AUDIO) as u16).to_be_bytes());
    pes[6..9].copy_from_slice(&[0x81, 0x80, 5]);
    pes[9] = 0x21 | ((pts >> 29) & 0x0E) as u8;
    pes[10..12].copy_from_slice(&((((pts >> 14) & 0xFFFE) | 1) as u16).to_be_bytes());
    pes[12..14].copy_from_slice(&((((pts << 1) & 0xFFFE) | 1) as u16).to_be_bytes());
    pes[14..16].copy_from_slice(&(AUDIO as u16).to_be_bytes());
    pes[16] = 0x31;
    pes[17] = 0x40;
    for (i, b) in pes[18..18 + AUDIO].iter_mut().enumerate() {
        *b = (k as usize * 7 + i).wrapping_add(seq as usize) as u8;
    }
    p
}

/// 一个 aligned unit 的 TS 包：按 PTS 交错写入 `audio_pids` 各自的 LPCM PES，
/// 每条轨都是完整可解的流（只在 PID 上区分），因此选轨后仍能 mux。
fn unit_packets(k0: u32, n: u32, audio_pids: &[u16]) -> Vec<[u8; 192]> {
    const PACKETS_PER_UNIT: u32 = 32;
    const PES_PACKETS: u32 = 6;
    let mut out: Vec<[u8; 192]> = Vec::with_capacity(PACKETS_PER_UNIT as usize);
    // 每条轨各占 PES_PACKETS 个包，其余填充 null 包。
    let per_track = PACKETS_PER_UNIT / PES_PACKETS;
    for slot in 0..per_track {
        let t = (slot as usize) % audio_pids.len();
        let pid = audio_pids[t];
        for j in 0..PES_PACKETS {
            out.push(lpcm_source_packet(
                k0 + slot * PES_PACKETS + j,
                n,
                pid,
                false,
                t as u8,
            ));
        }
    }
    while out.len() < PACKETS_PER_UNIT as usize {
        out.push(lpcm_source_packet(k0, n, 0x1FFF, false, 0));
    }
    out.truncate(PACKETS_PER_UNIT as usize);
    out
}

/// 一个合成 BD 镜像。
pub struct SyntheticDisc {
    pub image: Vec<u8>,
}

/// 一个标题的规格。
#[derive(Clone, Copy)]
pub struct TitleSpec {
    /// 该标题 clip 的 aligned unit 数（决定体积与 mux 耗时）。
    pub units: u32,
    /// LPCM 音轨 PID 列表；长度 ≥ 1。
    pub audio_pids: &'static [u16],
    /// 第一条音轨的语言码（3 字母）。
    pub language: &'static [u8; 3],
    /// 声明时长（秒）。
    pub secs: u32,
}

impl TitleSpec {
    fn single(units: u32) -> Self {
        TitleSpec {
            units,
            audio_pids: &[AUDIO_PID_0],
            language: b"eng",
            secs: TITLE_SECS,
        }
    }
}

/// `titles` 个标题、每条 clip 一条音轨、全部明文的合成 BD 镜像。
pub fn synthetic_bd(titles: usize) -> SyntheticDisc {
    let specs: Vec<TitleSpec> = (0..titles)
        .map(|_| TitleSpec::single(DEFAULT_CLIP_UNITS))
        .collect();
    synthetic_bd_specs(&specs)
}

/// 按 `specs` 构造合成 BD 镜像：每条 clip 的 aligned unit 数、音轨 PID 数、
/// 语言与时长都可指定。全部明文（无 AACS 加密），因此不需要密钥。
pub fn synthetic_bd_specs(specs: &[TitleSpec]) -> SyntheticDisc {
    assert!(!specs.is_empty());
    let titles = specs.len();
    let playlists: Vec<Vec<u8>> = specs
        .iter()
        .enumerate()
        .map(|(i, s)| one_item_mpls(clip_id(i), s.audio_pids, s.language, s.secs))
        .collect();
    let uk_ro = libfreemkv::test_util::unit_key_ro(AacsVersion::V10, &[], &vec![1u16; titles]);
    let mut files = vec![BdFile::new("BDMV/index.bdmv", 1, None)];
    for i in 0..titles {
        files.push(BdFile::new(format!("BDMV/PLAYLIST/{i:05}.mpls"), 1, None));
    }
    for i in 0..titles {
        files.push(BdFile::new(format!("BDMV/CLIPINF/{i:05}.clpi"), 1, None));
    }
    for (i, spec) in specs.iter().enumerate() {
        files.push(BdFile::new(
            format!("BDMV/STREAM/{i:05}.m2ts"),
            spec.units * 3,
            None,
        ));
    }
    let mut img = encrypted_bd_image(&files, &uk_ro);
    for (i, spec) in specs.iter().enumerate() {
        let (start, _) = img.files[1 + titles + titles + i];
        let n_packets = spec.units * 32;
        for u in 0..spec.units {
            let packets = unit_packets(u * 32, n_packets, spec.audio_pids);
            let mut unit: Vec<u8> = packets.into_iter().flatten().collect();
            // 补齐到整个 aligned unit（6144 字节 = 32 * 192）。
            unit.resize(32 * 192, 0);
            let at = (start + u * 3) as usize * 2048;
            img.image[at..at + unit.len()].copy_from_slice(&unit);
        }
    }
    for (f, bytes) in playlists.iter().enumerate() {
        let at = img.files[1 + f].0 as usize * 2048;
        img.image[at..at + bytes.len()].copy_from_slice(bytes);
    }
    for (i, spec) in specs.iter().enumerate() {
        let bytes = minimal_clpi(spec.units * 32);
        let at = img.files[1 + titles + i].0 as usize * 2048;
        img.image[at..at + bytes.len()].copy_from_slice(&bytes);
    }
    SyntheticDisc { image: img.image }
}

/// 上游合成的单标题 MPEG-2 视频 + 双 AC-3 音频镜像，可直接检查 0/1/2 条音轨的产物。
pub fn synthetic_bd_with_video(units: usize) -> SyntheticDisc {
    let clip = synthetic_bd_clip(units);
    let source_packets = (clip.len() / 192) as u32;
    let playlist = one_item_mpls_with_video(
        clip_id(0),
        &libfreemkv::test_util::CLIP_AUDIO_PIDS,
        b"jpn",
        TITLE_SECS,
        libfreemkv::test_util::CLIP_VIDEO_PID,
    );
    let uk_ro = libfreemkv::test_util::unit_key_ro(AacsVersion::V10, &[], &[1]);
    let files = [
        BdFile::new("BDMV/index.bdmv", 1, None),
        BdFile::new("BDMV/PLAYLIST/00000.mpls", 1, None),
        BdFile::new("BDMV/CLIPINF/00000.clpi", 1, None),
        BdFile::new("BDMV/STREAM/00000.m2ts", 0, None).with_clip(clip),
    ];
    let mut img = encrypted_bd_image(&files, &uk_ro);
    for (i, bytes) in [(1, playlist), (2, minimal_clpi(source_packets))] {
        let at = img.files[i].0 as usize * 2048;
        img.image[at..at + bytes.len()].copy_from_slice(&bytes);
    }
    SyntheticDisc { image: img.image }
}
