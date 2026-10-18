'use strict';

// 只读取 ASAR 目录元数据，验证新入口和下载缓存边界；不解包或启动 Electron。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const requiredFiles = [
  'main/dsd.js',
  'html/dsd.html',
  'html/js/dsd.js',
  'html/css/dsd.css',
];

function verifyPackage(archivePath) {
  assert.ok(fs.statSync(archivePath).isFile(), 'app.asar 必须是文件');
  const entries = asar.listPackage(archivePath, { isPack: false })
    .map(entry => entry.replaceAll('\\', '/').replace(/^\/+/, ''));
  const included = new Set(entries);

  for (const file of requiredFiles) {
    assert.ok(included.has(file), `安装包缺少 DSD 文件：${file}`);
    // asar 3.x 按 path.sep 拆分目录；传本机路径以支持 Windows 多层目录。
    const metadata = asar.statFile(archivePath, path.normalize(file));
    assert.ok(typeof metadata.size === 'number' && metadata.size > 0,
      `安装包中的 DSD 文件为空或不是常规文件：${file}`);
  }

  const forbidden = entries.filter(entry =>
    /^(?:ffmpeg(?:[._/-]|$)|ffmac(?:[._/-]|$)|ffgui-ffmpeg(?:[._/-]|$))/i.test(entry)
    || /(?:^|\/)(?:ffmpeg|ffprobe)(?:\.exe)?$/i.test(entry));
  assert.equal(forbidden.length, 0,
    `FFmpeg 下载压缩包、展开目录或工具误入 app.asar：${forbidden.slice(0, 12).join(', ')}`);

  console.log(`安装包目录检查通过：${archivePath}`);
  console.log(`DSD 必要文件 ${requiredFiles.length} 个；ASAR 中无 FFmpeg 下载缓存或 ffprobe 二进制。`);
}

try {
  assert.equal(process.argv.length, 3,
    '用法：node scripts/verify-package.cjs <app.asar 路径>');
  verifyPackage(path.resolve(process.argv[2]));
} catch (error) {
  console.error(`安装包目录检查失败：${error.message}`);
  process.exitCode = 1;
}
