# NSISBI（免安装版，已裁剪）

本目录为 [NSISBI](https://sourceforge.net/projects/nsisbi/)（NSIS 的解除 2GB 限制分支）的
免安装 amd64 压缩包裁剪版，仅用于在 Windows 上编译 `assets/installer.nsi` 生成 FFGui 安装包。

- 版本：`nsisbi-3.12.2-amd64.zip`（SourceForge → nsisbi3.12.2）
- 来源：https://sourceforge.net/projects/nsisbi/files/nsisbi3.12.2/nsisbi-3.12.2-amd64.zip/download
- 许可证：NSIS 许可证（zlib/libpng 风格，见 `COPYING`），允许再分发
- 裁剪内容：删除 `Docs/`、`Examples/`、`NSIS.chm`、`NSIS.exe`、`makensisw.exe`（文档与 GUI 工具），
  保留 `makensis.exe`、`Bin/`、`Stubs/`、`Include/`、`Contrib/`（含 MUI2 与现代界面资源）、`Plugins/`
- 升级：替换本目录内容时注意 `Contrib/`（MUI2 界面与语言文件）与 `Stubs/` 必须成套，
  并在 `assets/installer.nsi` 基础上重新验证安装包

调用入口：`scripts/build-installer.cjs`（传入 `installer.nsi` 与生成的中文 defines）。
