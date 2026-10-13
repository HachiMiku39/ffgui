// 主题设置：持久化用户选择（跟随系统/浅色/深色）、经 nativeTheme.themeSource 生效、主题切换 IPC
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const THEMES = ['system', 'light', 'dark']; // 合法主题值，默认 system（跟随系统）

// 读取 / 写入持久化的主题设置（userData/config.json 的 theme 字段）
function loadAppTheme() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
    return THEMES.includes(cfg.theme) ? cfg.theme : 'system';
  } catch {
    return 'system'; // 配置文件不存在或损坏时按默认（跟随系统）处理
  }
}

function saveAppTheme(theme) {
  const cfgPath = path.join(app.getPath('userData'), 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    // 配置文件不存在或损坏时重建
  }
  cfg.theme = theme;
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('[ffgui] 保存主题设置失败:', err);
  }
}

// 启动时应用持久化的主题：themeSource 会强制渲染进程的 prefers-color-scheme，
// 渲染进程只需监听 matchMedia 即可覆盖 system/light/dark 三种状态
function initTheme() {
  nativeTheme.themeSource = loadAppTheme();
}

function registerThemeIpc() {
  // 查询当前主题设置（'system'/'light'/'dark'，非实际生效的明暗）
  ipcMain.handle('ffgui:theme-get', () => THEMES.includes(nativeTheme.themeSource) ? nativeTheme.themeSource : 'system');

  // 切换主题：持久化 + 改 themeSource（所有窗口经 prefers-color-scheme 变化自动换肤），
  // 然后广播设置值供各页面更新切换图标
  ipcMain.on('ffgui:theme-set', (event, theme) => {
    if (!THEMES.includes(theme)) return;
    saveAppTheme(theme);
    nativeTheme.themeSource = theme;
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send('ffgui:theme-changed', theme);
    });
  });
}

module.exports = { initTheme, registerThemeIpc };
