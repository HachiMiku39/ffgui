//! 光盘源的三种形态：iso / folder / drive。
//!
//! iso 与 folder 的扫描和 mux 由 freemkv-engine 的 `ImageSource` 承担；
//! drive 保留上游设备路径，由 `open_scan_with` / `DiscSession` 打开。
//! 上游未覆盖的平台在 jobs 层明确返回 `FFGUI_UNSUPPORTED`。

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub enum SourceKind {
    Iso(PathBuf),
    Folder(PathBuf),
    Drive(PathBuf),
}

#[derive(Debug, Clone)]
pub struct DiscSource {
    pub kind: SourceKind,
}

impl DiscSource {
    pub fn path(&self) -> &Path {
        match &self.kind {
            SourceKind::Iso(p) | SourceKind::Folder(p) | SourceKind::Drive(p) => p,
        }
    }

    /// 按协议里的 kind 字段构造。路径必须是绝对路径的非空字符串。
    pub fn parse(kind: &str, path: &str) -> Result<Self, String> {
        let kind_name = match kind {
            "iso" => SourceKind::Iso(PathBuf::new()),
            "folder" => SourceKind::Folder(PathBuf::new()),
            "drive" => SourceKind::Drive(PathBuf::new()),
            other => {
                return Err(other.to_string());
            }
        };
        if path.trim().is_empty() {
            return Err(kind.to_string());
        }
        let p = PathBuf::from(path);
        let resolved = match &kind_name {
            SourceKind::Iso(_) | SourceKind::Folder(_) => {
                let abs = std::path::absolute(&p).map_err(|_| kind.to_string())?;
                if !abs.exists() {
                    return Err(kind.to_string());
                }
                match &kind_name {
                    SourceKind::Iso(_) => {
                        if abs.is_dir() {
                            return Err(kind.to_string());
                        }
                        SourceKind::Iso(abs)
                    }
                    _ => {
                        if !abs.is_dir() {
                            return Err(kind.to_string());
                        }
                        SourceKind::Folder(abs)
                    }
                }
            }
            SourceKind::Drive(_) => SourceKind::Drive(p),
        };
        Ok(DiscSource { kind: resolved })
    }
}
