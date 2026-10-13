// 本地 Electron Forge maker：用仓库内置的 NSISBI（tools/nsisbi）编译
// Windows 安装包（assets/installer.nsi），替代原 Squirrel maker。
// 实际编译逻辑在 scripts/build-installer.cjs，这里只做 Forge 适配。

const path = require('path');
const { MakerBase } = require('@electron-forge/maker-base');
const { build } = require('../scripts/build-installer.cjs');

class MakerNsis extends MakerBase {
  name = 'nsis';
  defaultPlatforms = ['win32'];

  // 编译器为仓库内置的 makensis.exe，无外部依赖；仅支持在 Windows 上构建
  isSupportedOnCurrentPlatform() {
    return process.platform === 'win32';
  }

  async make({ dir, makeDir, targetArch }) {
    const outFile = build({ appDir: dir, outDir: path.join(makeDir, 'nsis'), arch: targetArch });
    return [outFile];
  }
}

module.exports = MakerNsis;
