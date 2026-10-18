'use strict';

// 交由 GitHub Actions 运行：node --test scripts/dsd-ui.test.cjs
// 完整执行渲染层 IIFE，使用假 DOM / IPC；不启动 Electron，不读取或转换真实媒体。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(repo, 'html/dsd.html'), 'utf8');
const source = fs.readFileSync(path.join(repo, 'html/js/dsd.js'), 'utf8');

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = new Map();
    this.handlers = new Map();
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this._text = '';
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const keep = force === undefined ? !this._classes.has(name) : force;
        if (keep) this._classes.add(name); else this._classes.delete(name);
        return keep;
      },
    };
    this.style = {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, value); },
      getPropertyValue(name) { return this.values.get(name) || ''; },
    };
  }
  set className(value) { this._classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  contains(other) { return other === this || this.children.some((child) => child.contains(other)); }
  addEventListener(type, callback) {
    const list = this.handlers.get(type) || [];
    list.push(callback);
    this.handlers.set(type, list);
  }
  dispatch(type, extra = {}) {
    const event = { prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    const promises = (this.handlers.get(type) || []).map((callback) => callback(event));
    return { event, done: Promise.all(promises) };
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function info(file, level = 64, family = 44100) {
  return { path: file, container: /\.dff$/i.test(file) ? 'dff' : 'dsf',
    dsdRate: family * level, dsdLevel: level, family, channels: 2, duration: 61,
    targetRate: family * (level === 64 ? 2 : 4), compression: 'DSD' };
}
function descendants(node) { return node.children.flatMap((child) => [child, ...descendants(child)]); }
function withClass(node, className) { return descendants(node).filter((child) => child.classList.contains(className)); }

function createPage(options = {}) {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeNode()]));
  const values = { 'sel-format': 'flac', 'sel-sample-rate': 'auto', 'sel-bit-depth': '24', 'input-gain': '0' };
  for (const [id, value] of Object.entries(values)) elements[id].value = value;
  elements['copy-metadata'].checked = true;
  elements['copy-cover'].checked = true;
  const win = new FakeNode('window');
  win.location = { href: 'dsd.html' };
  let listener = null;
  const conversion = deferred();
  const calls = { probes: [], jobs: [], cancelled: 0, unsubscribed: 0, paths: [] };
  win.ffgui = {
    platform: options.platform || 'linux',
    dsdPickFiles: async () => options.picked || [],
    getPathForFile: (file) => { calls.paths.push(file); return file.path; },
    pickDirectory: async () => options.directory || '/output',
    dsdProbe: async (files) => {
      calls.probes.push(plain(files));
      return options.probe ? options.probe(files, calls.probes.length) : files.map((file) => info(file));
    },
    onConvertEvent: (callback) => {
      listener = callback;
      return () => { calls.unsubscribed++; listener = null; };
    },
    dsdConvert: (job) => {
      calls.jobs.push(plain(job));
      return options.convert ? options.convert(job, calls.jobs.length) : conversion.promise;
    },
    cancelConvert: async () => { calls.cancelled++; if (options.cancel) await options.cancel(); },
  };
  vm.runInNewContext(source, {
    document: { getElementById: (id) => elements[id], createElement: (tag) => new FakeNode(tag) },
    window: win,
  }, { filename: 'html/js/dsd.js' });
  return {
    elements, win, calls, conversion,
    click: (id) => elements[id].dispatch('click').done,
    change: async (id, value) => { elements[id].value = value; await elements[id].dispatch('change').done; },
    drop: (files) => elements['file-panel'].dispatch('drop', {
      dataTransfer: { files: files.map((file) => ({ path: file, name: file.split(/[\\/]/).pop() })) },
    }).done,
    emit: (event) => { if (listener) listener(event); },
    rows: () => elements['file-list'].children.filter((row) => row.classList.contains('dsd-file-item')),
    statuses: () => withClass(elements['file-list'], 'file-status').map((entry) => entry.textContent),
    percent: () => Number.parseFloat(elements['progress-bar'].style.getPropertyValue('--progress-width')),
  };
}

test('拖入批量 DSD：过滤重复和其他格式，使用真实规格显示两种家族的预期输出', async () => {
  const levels = [64, 128, 256, 512, 64, 128];
  const files = ['/a/DSD512.dsf', '/a/b.DFF', '/a/c.dsf', '/a/d.dsf', '/a/e.dsf', '/a/f.dff'];
  const page = createPage({ probe: (paths) => paths.map((file, index) => info(file, levels[index], index < 4 ? 44100 : 48000)) });
  await page.drop([...files, files[0], '/a/noise.flac']);
  assert.deepEqual(page.calls.probes, [files]);
  assert.equal(page.rows().length, 6);
  const expected = [88.2, 176.4, 176.4, 176.4, 96, 192];
  page.rows().forEach((row, index) => {
    assert.match(withClass(row, 'dsd-file-source')[0].textContent, new RegExp(`DSD${levels[index]} ·`));
    assert.ok(row.textContent.includes(`${expected[index]} kHz / 24-bit 整数 · FLAC`));
    assert.ok(row.textContent.includes('2 声道 · 00:01:01'));
  });
  assert.ok(page.elements['log-area'].textContent.includes('已忽略 1'));
  assert.equal(page.elements['btn-start'].disabled, false);
  await page.change('sel-sample-rate', '352800');
  for (const row of page.rows()) assert.ok(row.textContent.includes('352.8 kHz / 24-bit'));
  await page.change('sel-sample-rate', 'auto');
  assert.ok(page.rows()[0].textContent.includes('88.2 kHz / 24-bit'));
});

test('Windows 路径去重及不可信文件名均按文本展示', async () => {
  const page = createPage({ platform: 'win32' });
  await page.drop(['C:\\Music\\Track.DSF', 'c:/music/track.dsf', 'C:\\Music\\<img onerror=bad>.dsf']);
  assert.equal(page.rows().length, 2);
  assert.equal(withClass(page.rows()[1], 'dsd-file-name')[0].textContent, '<img onerror=bad>.dsf');
  assert.ok(!descendants(page.elements['file-list']).some((entry) => entry.tagName === 'img'));
});

test('添加按钮、移除、目录选择与恢复默认不会漏传用户设置', async () => {
  const page = createPage({ picked: ['/a.dsf', '/b.dff'] });
  await page.click('btn-add-files');
  await withClass(page.rows()[0], 'file-remove')[0].dispatch('click').done;
  assert.equal(page.rows().length, 1);
  await page.click('btn-pick-dir');
  assert.equal(page.elements['input-outdir'].value, '/output');
  await page.click('btn-reset-dir');
  assert.equal(page.elements['input-outdir'].value, '');
  await page.click('btn-pick-dir');
  page.elements['copy-metadata'].checked = false;
  page.elements['copy-cover'].checked = false;
  page.elements['input-gain'].value = '-3';
  const running = page.click('btn-start');
  assert.deepEqual(page.calls.jobs[0], {
    inputs: ['/b.dff'], outputDir: '/output', format: 'flac', sampleRate: 'auto',
    bitDepth: '24', gainDb: -3, copyMetadata: false, copyCover: false,
  });
  page.emit({ type: 'file-done', input: '/b.dff', index: 0, output: '/output/b.flac' });
  page.conversion.resolve({ done: 1, total: 1, cancelled: false });
  await running;
  assert.deepEqual(page.statuses(), ['完成']);
});

test('WAV 浮点与 FLAC 联动，并阻止被伪造的 FLAC 浮点任务', async () => {
  const page = createPage();
  await page.drop(['/a.dsf']);
  await page.change('sel-format', 'wav');
  assert.equal(page.elements['option-float'].disabled, false);
  assert.equal(page.elements['copy-cover'].disabled, true);
  await page.change('sel-bit-depth', '32f');
  assert.ok(page.rows()[0].textContent.includes('32-bit 浮点 · WAV'));
  await page.change('sel-format', 'flac');
  assert.equal(page.elements['sel-bit-depth'].value, '24');
  assert.equal(page.elements['option-float'].disabled, true);
  assert.equal(page.elements['copy-cover'].disabled, false);
  page.elements['sel-bit-depth'].value = '32f';
  await page.click('btn-start');
  assert.equal(page.calls.jobs.length, 0);
  assert.match(page.elements['status-text'].textContent, /32-bit 浮点请选择 WAV/);
  await page.change('sel-format', 'wav');
  const running = page.click('btn-start');
  assert.equal(page.calls.jobs[0].bitDepth, '32f');
  assert.equal(page.calls.jobs[0].copyCover, false);
  page.emit({ type: 'file-warning', input: '/a.dsf', warning: '峰值超过 0 dBFS，后续编辑请注意电平' });
  page.emit({ type: 'file-done', input: '/a.dsf', output: '/a.wav' });
  page.conversion.resolve({ done: 1, total: 1, cancelled: false });
  await running;
  assert.ok(page.rows()[0].textContent.includes('峰值超过 0 dBFS'));
});

test('扫描进度不表示文件已完成；未知输入的共享进度不会污染队列', async () => {
  const page = createPage();
  await page.drop(['/a.dsf']);
  const running = page.click('btn-start');
  page.emit({ type: 'file-start', index: 0, input: '/a.dsf', phase: 'scan' });
  page.emit({ type: 'progress', index: 0, input: '/a.dsf', phase: 'scan', percent: 100 });
  assert.match(page.statuses()[0], /检查峰值/);
  assert.ok(page.percent() > 49 && page.percent() <= 50);
  page.emit({ type: 'file-done', index: 0, input: '/unrelated.dsf', output: '/bad.flac' });
  assert.match(page.statuses()[0], /检查峰值/);
  page.emit({ type: 'file-start', index: 0, input: '/a.dsf', phase: 'convert' });
  assert.equal(page.percent(), 50);
  page.emit({ type: 'progress', index: 0, input: '/a.dsf', phase: 'convert', percent: Infinity });
  assert.equal(page.percent(), 50);
  page.emit({ type: 'progress', index: 0, input: '/a.dsf', phase: 'convert', percent: 100 });
  assert.ok(page.percent() < 100);
  assert.match(page.statuses()[0], /转换/);
  page.emit({ type: 'file-done', index: 0, input: '/a.dsf', output: '/a.flac' });
  page.conversion.resolve({ done: 1, total: 1, cancelled: false });
  await running;
  assert.equal(page.percent(), 100);
  assert.deepEqual(page.statuses(), ['完成']);
  assert.equal(page.calls.unsubscribed, 1);
});

test('批量取消：保持已完成文件、取消当前及等待项，锁定队列并防止重复提交', async () => {
  const page = createPage();
  await page.drop(['/a.dsf', '/b.dsf', '/c.dff']);
  const running = page.click('btn-start');
  await page.click('btn-start');
  assert.equal(page.calls.jobs.length, 1);
  for (const id of ['btn-add-files', 'btn-clear-files', 'btn-back', 'sel-format', 'sel-sample-rate',
    'sel-bit-depth', 'input-gain', 'copy-metadata', 'copy-cover', 'btn-pick-dir']) {
    assert.equal(page.elements[id].disabled, true, `${id} 必须锁定`);
  }
  const unload = page.win.dispatch('beforeunload');
  assert.equal(unload.event.prevented, true);
  await unload.done;
  await page.click('btn-back');
  await page.click('btn-clear-files');
  await page.drop(['/ignored.dsf']);
  assert.equal(page.win.location.href, 'dsd.html');
  assert.equal(page.rows().length, 3);
  assert.equal(page.calls.probes.length, 1);
  page.emit({ type: 'file-done', input: '/a.dsf', output: '/a.flac' });
  page.emit({ type: 'progress', input: '/b.dsf', phase: 'scan', percent: 20 });
  await page.click('btn-cancel');
  await page.click('btn-cancel');
  assert.equal(page.calls.cancelled, 1);
  assert.equal(page.elements['btn-cancel'].disabled, true);
  page.emit({ type: 'file-error', input: '/b.dsf', cancelled: true, error: '已取消' });
  page.conversion.resolve({ done: 1, total: 3, cancelled: true });
  await running;
  assert.deepEqual(page.statuses(), ['完成', '已取消', '已取消']);
  assert.match(page.elements['status-text'].textContent, /已取消：完成 1\/3/);
  assert.equal(page.elements['btn-start'].disabled, false);
  assert.equal(page.elements['btn-back'].disabled, false);
  assert.equal(page.calls.unsubscribed, 1);
});

test('探测清空后迟到的旧结果不能污染同路径新条目', async () => {
  const old = deferred();
  const page = createPage({ probe: (files, count) => count === 1 ? old.promise : files.map((file) => info(file, 128)) });
  const adding = page.drop(['/same.dsf']);
  assert.equal(page.elements['btn-start'].disabled, true);
  await page.click('btn-clear-files');
  await page.drop(['/same.dsf']);
  old.resolve([{ path: '/same.dsf', error: '旧请求报错' }]);
  await adding;
  assert.equal(page.rows().length, 1);
  assert.ok(page.rows()[0].textContent.includes('DSD128'));
  assert.ok(page.rows()[0].textContent.includes('176.4 kHz'));
  assert.ok(!page.rows()[0].textContent.includes('旧请求报错'));
  assert.equal(page.elements['btn-start'].disabled, false);
});

test('探测失败项留在队列供查看，提交时仅处理有效文件且错误按路径匹配', async () => {
  const page = createPage({ probe: () => [
    { path: '/bad.dsf', error: '文件头损坏' }, info('/good.dsf', 512),
  ] });
  await page.drop(['/good.dsf', '/bad.dsf']);
  assert.deepEqual(page.statuses(), ['待转换', '探测失败']);
  assert.match(page.elements['queue-hint'].textContent, /1 个文件探测失败/);
  const running = page.click('btn-start');
  assert.deepEqual(page.calls.jobs[0].inputs, ['/good.dsf']);
  page.emit({ type: 'file-error', index: 0, input: '/good.dsf', cancelled: false, error: '峰值过高，请降低增益' });
  page.conversion.resolve({ done: 0, total: 1, cancelled: false });
  await running;
  assert.deepEqual(page.statuses(), ['失败', '探测失败']);
  assert.ok(page.rows()[0].textContent.includes('峰值过高，请降低增益'));
});

test('IPC 抛错后取消订阅并解除锁定，非法增益不提交任务', async () => {
  const page = createPage({ convert: async () => { throw new Error('找不到 FFmpeg'); } });
  await page.drop(['/a.dsf']);
  for (const bad of ['', 'NaN', '-12.1', '6.1']) {
    page.elements['input-gain'].value = bad;
    await page.click('btn-start');
  }
  assert.equal(page.calls.jobs.length, 0);
  page.elements['input-gain'].value = '0';
  await page.click('btn-start');
  assert.equal(page.calls.unsubscribed, 1);
  assert.equal(page.elements['btn-start'].disabled, false);
  assert.equal(page.elements['btn-back'].disabled, false);
  assert.match(page.elements['status-text'].textContent, /找不到 FFmpeg/);
});

test('页面保持 CSP 与 preload 最小 API，并先加载主题脚本', () => {
  assert.match(html, /content="default-src 'self'; style-src 'self'; script-src 'self'"/);
  assert.ok(!/unsafe-inline|unsafe-eval|\bon\w+=|<script[^>]*>\s*[^<\s]/i.test(html));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\brequire\s*\(/.test(source));
  assert.ok(html.indexOf('js/theme.js') < html.indexOf('js/dsd.js'));
  assert.match(html, /不代表 DSD 与 PCM 的音质等价/);
  assert.match(html, /不自动增加 6 dB 或逐曲归一化/);
  const preload = fs.readFileSync(path.join(repo, 'preload/preload.js'), 'utf8');
  for (const channel of ['ffgui:dsd-pick-files', 'ffgui:dsd-probe', 'ffgui:dsd-convert']) {
    assert.ok(preload.includes(channel));
  }
  assert.match(fs.readFileSync(path.join(repo, 'index.js'), 'utf8'), /require\('\.\/main\/dsd'\)\.registerDsdIpc\(\)/);
});
