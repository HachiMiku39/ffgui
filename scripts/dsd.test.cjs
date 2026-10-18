// 云端运行：node --test scripts/dsd.test.cjs。需要 FFMPEG/FFPROBE 或 PATH 中的工具。
// 测试媒体完全合成，不读取用户音乐；所有文件位于独立临时目录。
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const dsd = require('../main/dsd');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffgui-dsd-'));
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
const source = fs.readFileSync(path.join(root, 'main/ffmpeg.js'), 'utf8');

function loadBackend(overrides = {}) {
  const context = {
    require: (name) => name === 'electron'
      ? { app: { isPackaged: false, getAppPath: () => root, getPath: () => temp } }
      : name === 'child_process' ? { ...cp,
        execFile: (_, ...args) => cp.execFile(ffmpeg, ...args),
        spawn: (_, ...args) => cp.spawn(ffmpeg, ...args), ...overrides } : require(name),
    process, console: { log() {} }, module: { exports: {} },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.module.exports;
}

function sender(events, hook = () => {}) {
  return { isDestroyed: () => false, send: (channel, event) => {
    assert.equal(channel, 'ffgui:convert-event');
    events.push(event); hook(event);
  } };
}

function chunk(name, payload, littleEndian = false) {
  const header = Buffer.alloc(12);
  header.write(name, 0, 'ascii');
  if (littleEndian) header.writeBigUInt64LE(BigInt(payload.length + 12), 4);
  else header.writeBigUInt64BE(BigInt(payload.length), 4);
  return Buffer.concat([header, payload, ...(!littleEndian && payload.length % 2 ? [Buffer.alloc(1)] : [])]);
}

function makeDsf(file, options = {}) {
  const { family = 44100, level = 64, channels = 2, duration = 0.025,
    amplitude = 0.2, frequency = null, dc = null, tags = null } = options;
  const rate = family * level;
  const samples = Math.floor(rate * duration / 8) * 8;
  const blocks = Math.ceil(samples / 8 / 4096);
  const audio = Buffer.alloc(blocks * channels * 4096, 0x69);
  if (frequency !== null || dc !== null) {
    for (let channel = 0; channel < channels; channel++) {
      let accumulator = 0;
      for (let byte = 0; byte < samples / 8; byte++) {
        let value = 0;
        for (let bit = 0; bit < 8; bit++) {
          const sample = byte * 8 + bit;
          accumulator += dc === null ? amplitude * Math.sin(2 * Math.PI * (frequency + channel * 1000) * sample / rate) : dc;
          const positive = accumulator >= 0;
          accumulator -= positive ? 1 : -1;
          if (positive) value |= 1 << bit;
        }
        audio[Math.floor(byte / 4096) * channels * 4096 + channel * 4096 + byte % 4096] = value;
      }
    }
  }
  const fmt = Buffer.alloc(40);
  fmt.writeUInt32LE(1, 0); fmt.writeUInt32LE(channels === 1 ? 1 : channels === 2 ? 2 : 7, 8);
  fmt.writeUInt32LE(channels, 12); fmt.writeUInt32LE(rate, 16); fmt.writeUInt32LE(1, 20);
  fmt.writeBigUInt64LE(BigInt(samples), 24); fmt.writeUInt32LE(4096, 32);
  const body = Buffer.concat([chunk('fmt ', fmt, true), chunk('data', audio, true)]);
  const head = Buffer.alloc(28);
  head.write('DSD ', 0, 'ascii'); head.writeBigUInt64LE(28n, 4);
  head.writeBigUInt64LE(BigInt(28 + body.length + (tags ? tags.length : 0)), 12);
  if (tags) head.writeBigUInt64LE(BigInt(28 + body.length), 20);
  fs.writeFileSync(file, Buffer.concat([head, body, ...(tags ? [tags] : [])]));
  return file;
}

function makeDff(file, { family = 44100, level = 64, channels = 2, dst = false } = {}) {
  const rate = family * level;
  const rateBytes = Buffer.alloc(4); rateBytes.writeUInt32BE(rate);
  const channelBytes = Buffer.alloc(2 + channels * 4); channelBytes.writeUInt16BE(channels);
  for (let i = 0; i < channels; i++) channelBytes.write(i === 0 ? 'SLFT' : i === 1 ? 'SRGT' : 'C   ', 2 + i * 4, 'ascii');
  const cmpr = Buffer.from(dst ? 'DST \x03DST' : 'DSD \x03DSD', 'binary');
  const props = chunk('PROP', Buffer.concat([Buffer.from('SND '), chunk('FS  ', rateBytes),
    chunk('CHNL', channelBytes), chunk('CMPR', cmpr)]));
  let audio;
  if (dst) {
    const frames = Buffer.alloc(6); frames.writeUInt32BE(75); frames.writeUInt16BE(75, 4);
    // 仅供文件头解析测试；DSTF 压缩帧不是实际编码的音乐。
    audio = chunk('DST ', Buffer.concat([chunk('FRTE', frames), chunk('DSTF', Buffer.alloc(2))]));
  } else audio = chunk('DSD ', Buffer.alloc(Math.floor(rate * 0.025 / 8) * channels, 0x69));
  const version = Buffer.from([1, 5, 0, 0]);
  fs.writeFileSync(file, chunk('FRM8', Buffer.concat([Buffer.from('DSD '), chunk('FVER', version),
    chunk('JUNK', Buffer.from([1])), props, audio])));
  return file;
}

function id3(png) {
  const frame = (name, bytes) => {
    const head = Buffer.alloc(10); head.write(name); head.writeUInt32BE(bytes.length, 4);
    return Buffer.concat([head, bytes]);
  };
  const body = Buffer.concat([
    frame('TIT2', Buffer.from('\0DSD fixture')),
    frame('TALB', Buffer.concat([Buffer.from([1, 255, 254]), Buffer.from('中文专辑', 'utf16le')])),
    frame('APIC', Buffer.concat([Buffer.from('\0image/png\0\x03\0', 'binary'), png])),
  ]);
  const head = Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 4; i++) head[9 - i] = (body.length >>> (i * 7)) & 127;
  return Buffer.concat([head, body]);
}

function probe(file) {
  return JSON.parse(cp.execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { encoding: 'utf8', timeout: 30000 }));
}

const fixtures = [];
before(() => {
  for (const program of [ffmpeg, ffprobe]) {
    const result = cp.spawnSync(program, ['-version'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, `需要可执行的 ${program}：${result.error?.message || result.stderr}`);
  }
  for (const family of [44100, 48000]) for (const level of [64, 128, 256, 512]) {
    // 名称故意写 DSD512，验证倍率判断来自内容而非文件名。
    const file = makeDsf(path.join(temp, `DSD512-${family}-${level}.dsf`), { family, level });
    fixtures.push({ file, family, level });
  }
});
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('DSF 与 DFF 从真实头部识别两个家族、四档倍率及精确时长', () => {
  for (const { file, family, level } of fixtures) {
    for (const sourceFile of [file, makeDff(path.join(temp, `${family}-${level}.dff`), { family, level })]) {
      const info = dsd.readDsdHeader(sourceFile);
      assert.equal(info.dsdRate, family * level); assert.equal(info.family, family);
      assert.equal(info.dsdLevel, level); assert.equal(info.channels, 2);
      assert.equal(info.targetRate, family * (level === 64 ? 2 : 4));
      assert.ok(info.duration > 0.02 && info.duration <= 0.025);
    }
  }
  const dst = dsd.readDsdHeader(makeDff(path.join(temp, 'compressed.dff'), { dst: true }));
  assert.equal(dst.compression, 'DST'); assert.equal(dst.duration, 1);
});

test('拒绝伪扩展名、截断、越界块、未知采样率及非法IPC参数', () => {
  const invalid = path.join(temp, 'fake.dsf'); fs.writeFileSync(invalid, 'not an audio file');
  assert.match(dsd.probeDsdFiles([invalid])[0].error, /不是 DSF\/DFF/);
  const truncated = path.join(temp, 'truncated.dsf');
  fs.writeFileSync(truncated, fs.readFileSync(fixtures[0].file).subarray(0, 90));
  assert.throws(() => dsd.readDsdHeader(truncated), /长度|截断/);
  const bad = fs.readFileSync(fixtures[0].file);
  bad.writeBigUInt64LE(2n ** 63n, 32); fs.writeFileSync(invalid, bad);
  assert.throws(() => dsd.readDsdHeader(invalid), /安全范围/);
  const unknown = fs.readFileSync(fixtures[0].file); unknown.writeUInt32LE(1234567, 56);
  fs.writeFileSync(invalid, unknown); assert.throws(() => dsd.readDsdHeader(invalid), /不支持的 DSD/);
  assert.throws(() => dsd.normalizeDsdJob({ inputs: ['https://example.test/a.dsf'] }), /绝对路径/);
  const base = { inputs: [fixtures[0].file] };
  for (const extra of [{ format: 'mp3' }, { format: 'flac', bitDepth: '32f' }, { gainDb: '+6;anull' },
    { gainDb: Infinity }, { gainDb: 7 }, { sampleRate: '176400' }, { sampleRate: 44100 }, { copyCover: 1 }]) {
    assert.throws(() => dsd.normalizeDsdJob({ ...base, ...extra }));
  }
});

test('真实FFmpeg：两个家族的DSD64～512均按自动规则输出24-bit FLAC', async () => {
  const events = []; const backend = loadBackend();
  const result = await dsd.runDsdJob(sender(events), { inputs: fixtures.map((x) => x.file) }, { backend });
  assert.equal(result.done, 8, JSON.stringify(events.filter((e) => e.type === 'file-error')));
  assert.equal(result.cancelled, false);
  const outputs = events.filter((e) => e.type === 'file-done');
  assert.equal(outputs.length, 8);
  for (const event of outputs) {
    const input = fixtures.find((x) => x.file === event.input);
    const track = probe(event.output).streams.find((s) => s.codec_type === 'audio');
    assert.equal(Number(track.sample_rate), input.family * (input.level === 64 ? 2 : 4));
    assert.equal(Number(track.bits_per_raw_sample), 24); assert.equal(track.channels, 2);
    assert.equal(track.codec_name, 'flac');
  }
  assert.ok(events.some((e) => e.type === 'progress' && e.phase === 'scan'));
  assert.ok(events.some((e) => e.type === 'progress' && e.phase === 'convert'));
});

test('真实FFmpeg：DFF→24-bit WAV保留声道，DSD64手动384kHz→32float WAV', async () => {
  const dff = makeDff(path.join(temp, 'multichannel.dff'), { family: 48000, level: 128, channels: 2 });
  const surround = makeDsf(path.join(temp, 'surround.dsf'), { channels: 6 });
  for (const [input, job, expectedRate, codec, expectedChannels] of [
    [dff, { format: 'wav', bitDepth: '24' }, 192000, 'pcm_s24le', 2],
    [surround, { format: 'wav', bitDepth: '24' }, 88200, 'pcm_s24le', 6],
    [fixtures[0].file, { format: 'wav', bitDepth: '32f', sampleRate: 384000 }, 384000, 'pcm_f32le', 2],
  ]) {
    const events = [];
    const result = await dsd.runDsdJob(sender(events), { inputs: [input], ...job }, { backend: loadBackend() });
    assert.equal(result.done, 1, JSON.stringify(events));
    const track = probe(events.find((e) => e.type === 'file-done').output).streams.find((s) => s.codec_type === 'audio');
    assert.equal(track.codec_name, codec); assert.equal(Number(track.sample_rate), expectedRate); assert.equal(track.channels, expectedChannels);
  }
});

test('真实FFmpeg：24-bit成品有非静音音频，保留两声道不同的频率', async (t) => {
  const input = makeDsf(path.join(temp, 'tones.dsf'), { duration: 0.12, frequency: 1000 });
  const events = [];
  const result = await dsd.runDsdJob(sender(events), { inputs: [input] }, { backend: loadBackend() });
  assert.equal(result.done, 1, JSON.stringify(events));
  const out = events.find((e) => e.type === 'file-done').output;
  const bytes = cp.execFileSync(ffmpeg, ['-v', 'error', '-i', out, '-ss', '0.02', '-t', '0.08',
    '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], { timeout: 30000 });
  const count = bytes.length / 8;
  assert.ok(count > 6000);
  const rate = 88200;
  for (let channel = 0; channel < 2; channel++) {
    const targetFrequency = 1000 + channel * 1000;
    const otherFrequency = 1000 + (1 - channel) * 1000;
    let energy = 0, crossings = 0, weightSum = 0;
    let targetReal = 0, targetImaginary = 0, otherReal = 0, otherImaginary = 0;
    for (let i = 0; i < count; i++) {
      const value = bytes.readFloatLE(i * 8 + channel * 4);
      const weight = (1 - Math.cos(2 * Math.PI * i / (count - 1))) / 2;
      const targetPhase = 2 * Math.PI * targetFrequency * i / rate;
      const otherPhase = 2 * Math.PI * otherFrequency * i / rate;
      energy += weight * value * value; weightSum += weight;
      targetReal += weight * value * Math.cos(targetPhase);
      targetImaginary += weight * value * Math.sin(targetPhase);
      otherReal += weight * value * Math.cos(otherPhase);
      otherImaginary += weight * value * Math.sin(otherPhase);
      if (i && bytes.readFloatLE((i - 1) * 8 + channel * 4) <= 0 && value > 0) crossings++;
    }
    // 一阶1-bit合成器有量化残留，过零可能在零点附近被重复计数，不能当作音高测量。
    // 对真实解码结果独立投影至两个已知频率；Hann窗减少有限片段的频谱泄漏。
    const targetAmplitude = 2 * Math.hypot(targetReal, targetImaginary) / weightSum;
    const otherAmplitude = 2 * Math.hypot(otherReal, otherImaginary) / weightSum;
    const targetRms = targetAmplitude / Math.SQRT2;
    const coherentEnergyFraction = targetRms ** 2 / (energy / weightSum);
    const crosstalkDb = 20 * Math.log10(Math.max(otherAmplitude, 1e-15) / Math.max(targetAmplitude, 1e-15));
    const diagnostic = { channel, targetFrequency, zeroCrossingHz: crossings / (count / rate),
      targetRms, weightedRms: Math.sqrt(energy / weightSum), coherentEnergyFraction, crosstalkDb };
    t.diagnostic(JSON.stringify(diagnostic));
    assert.ok(targetRms > 0.05, `必须保留目标频率而非静音或噪声：${JSON.stringify(diagnostic)}`);
    assert.ok(coherentEnergyFraction > 0.95, `音调频率、采样速率或波形不正确：${JSON.stringify(diagnostic)}`);
    assert.ok(crosstalkDb < -40, `两声道发生混合或串扰：${JSON.stringify(diagnostic)}`);
  }
});

test('真实FFmpeg：FLAC保留中文标签及PNG封面，关闭后清除；WAV明确提示封面不支持', async () => {
  const png = cp.execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=16x16',
    '-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-c:v', 'png', '-'], { timeout: 30000 });
  const input = makeDsf(path.join(temp, 'tagged.dsf'), { tags: id3(png) });
  for (const job of [{ format: 'flac' }, { format: 'flac', copyCover: false, copyMetadata: false }, { format: 'wav' }]) {
    const events = [];
    const result = await dsd.runDsdJob(sender(events), { inputs: [input], ...job }, { backend: loadBackend() });
    assert.equal(result.done, 1, JSON.stringify(events));
    const info = probe(events.find((e) => e.type === 'file-done').output);
    const cover = info.streams.find((s) => s.disposition?.attached_pic);
    assert.equal(Boolean(cover), job.format === 'flac' && job.copyCover !== false);
    if (cover) assert.equal(cover.codec_name, 'png');
    if (job.copyMetadata !== false) {
      assert.equal(info.format.tags.title, 'DSD fixture'); assert.equal(info.format.tags.album, '中文专辑');
    } else assert.equal(info.format.tags?.title, undefined);
    if (job.format === 'wav') assert.ok(events.some((e) => e.type === 'file-warning' && /封面/.test(e.warning)));
  }
});

test('真实FFmpeg：扫描保留超过0dBFS的浮点峰值，整数拒绝、浮点保留并提示', async () => {
  const input = makeDsf(path.join(temp, 'overload.dsf'), { duration: 0.06, dc: 0.8 });
  for (const bitDepth of ['24', '32f']) {
    const events = [];
    const result = await dsd.runDsdJob(sender(events), { inputs: [input], format: 'wav', bitDepth, gainDb: 6 },
      { backend: loadBackend() });
    if (bitDepth === '24') {
      assert.equal(result.done, 0); assert.ok(events.some((e) => e.type === 'file-error' && /削波/.test(e.error)));
    } else {
      assert.equal(result.done, 1, JSON.stringify(events));
      assert.ok(events.some((e) => e.type === 'file-warning' && /浮点 WAV/.test(e.warning)));
      const out = events.find((e) => e.type === 'file-done').output;
      const bytes = cp.execFileSync(ffmpeg, ['-v', 'error', '-i', out, '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], { timeout: 30000 });
      let peak = 0; for (let i = 0; i < bytes.length; i += 4) peak = Math.max(peak, Math.abs(bytes.readFloatLE(i)));
      assert.ok(peak > 1, '浮点输出不得预先夹断到满刻度');
    }
  }
});

function mockBackend() {
  let calls = 0;
  const backend = loadBackend({ spawn: (_program, args) => {
    calls++;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    const out = args.at(-1);
    if (out !== '-') fs.writeFileSync(out, '本次任务的临时音频');
    process.nextTick(() => {
      if (!child.killed) {
        child.stderr.emit('data', Buffer.from('Peak level dB: -8.0\nNumber of samples: 100\nNumber of NaNs: 0\nNumber of Infs: 0\n'));
        child.stdout.emit('data', Buffer.from('out_time=00:00:00.025000\nprogress=end\n'));
      }
      child.emit('close', child.killed ? 1 : 0);
    });
    return child;
  } });
  backend.probeFile = async () => ({ hasAudio: true, audioTracks: [{}], covers: [] });
  backend.calls = () => calls;
  return backend;
}

test('取消扫描/转换均释放租约、清理本次半成品并保留源文件和历史输出', async () => {
  for (const phase of ['scan', 'convert']) {
    const dir = path.join(temp, `cancel-${phase}`); fs.mkdirSync(dir);
    const input = makeDsf(path.join(dir, 'song.dsf'));
    const original = fs.readFileSync(input); const existing = path.join(dir, 'song.flac');
    fs.writeFileSync(existing, '历史成品');
    const backend = mockBackend(); const events = [];
    const result = await dsd.runDsdJob(sender(events, (event) => {
      if (event.type === 'file-start' && event.phase === phase) backend.cancelCurrentTask();
    }), { inputs: [input] }, { backend });
    assert.equal(result.done, 0); assert.equal(result.cancelled, true);
    assert.deepEqual(fs.readFileSync(input), original); assert.equal(fs.readFileSync(existing, 'utf8'), '历史成品');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['song.dsf', 'song.flac']);
    const lease = backend.acquireTaskLease(); backend.releaseTaskLease(lease);
  }
});

test('批内同名文件自动避让；分配后出现的目标绝不覆盖', async () => {
  const dir = path.join(temp, 'collisions'); fs.mkdirSync(dir);
  const nested = path.join(dir, 'nested'); fs.mkdirSync(nested);
  const first = makeDsf(path.join(dir, 'same.dsf'));
  const second = makeDsf(path.join(nested, 'same.dsf'));
  const events = [];
  const result = await dsd.runDsdJob(sender(events), { inputs: [first, second], outputDir: dir }, { backend: mockBackend() });
  assert.equal(result.done, 2);
  assert.deepEqual(events.filter((e) => e.type === 'file-done').map((e) => path.basename(e.output)), ['same.flac', 'same_2.flac']);
  const collision = path.join(dir, 'same_3.flac'); const lateEvents = [];
  const late = await dsd.runDsdJob(sender(lateEvents, (event) => {
    if (event.type === 'file-start' && event.phase === 'scan') fs.writeFileSync(collision, '稍后创建的成品');
  }), { inputs: [first], outputDir: dir }, { backend: mockBackend() });
  assert.equal(late.done, 0); assert.equal(fs.readFileSync(collision, 'utf8'), '稍后创建的成品');
  assert.ok(lateEvents.some((e) => e.type === 'file-error'));
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.ffgui-dsd-')), false);
});

test('探测期间的租约阻止第二任务，不允许重置第一任务的取消状态', async () => {
  const backend = mockBackend(); let release;
  backend.probeFile = () => new Promise((resolve) => { release = resolve; });
  const pending = dsd.runDsdJob(sender([]), { inputs: [fixtures[0].file] }, { backend });
  await assert.rejects(dsd.runDsdJob(sender([]), { inputs: [fixtures[0].file] }, { backend }), /正在运行/);
  backend.cancelCurrentTask();
  release({ hasAudio: true, audioTracks: [{}], covers: [] });
  const result = await pending;
  assert.equal(result.cancelled, true); assert.equal(backend.calls(), 0);
});

test('真实FFmpeg：低通抑制60kHz超声内容，降采样后不形成明显可听混叠', async () => {
  const input = makeDsf(path.join(temp, 'ultrasonic.dsf'), { duration: 0.12, frequency: 60000 });
  const events = [];
  const result = await dsd.runDsdJob(sender(events), { inputs: [input] }, { backend: loadBackend() });
  assert.equal(result.done, 1, JSON.stringify(events));
  const out = events.find((e) => e.type === 'file-done').output;
  const bytes = cp.execFileSync(ffmpeg, ['-v', 'error', '-i', out, '-ss', '0.03', '-t', '0.06',
    '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], { timeout: 30000 });
  let energy = 0;
  for (let i = 0; i < bytes.length; i += 4) energy += bytes.readFloatLE(i) ** 2;
  assert.ok(bytes.length > 0);
  assert.ok(Math.sqrt(energy / (bytes.length / 4)) < 0.003, '超声信号不应折叠成明显可听的音频');
});

test('子进程error后到达的close不会重复终态或解除下一任务的占用', async () => {
  const children = [];
  const backend = loadBackend({ spawn: () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    children.push(child); return child;
  } });
  const events = [];
  const start = () => backend.runFfmpegTask({ args: [], index: 0, label: '测试', output: null,
    getDuration: () => 1, send: (e) => events.push(e), taskName: '测试' });
  const first = start(); children[0].emit('error', new Error('spawn失败')); await first;
  const next = start(); children[0].emit('close', 1);
  assert.throws(() => backend.acquireTaskLease(), /正在运行/);
  children[1].stdout.emit('data', Buffer.from('progress=end\n')); children[1].emit('close', 0);
  assert.equal((await next).ok, true);
  assert.equal(events.filter((e) => e.type === 'file-error').length, 1);
});

test('发布回退复制时取消或写入失败，均清理自己独占创建的半成品', async () => {
  for (const mode of ['cancel', 'error']) {
    const dir = path.join(temp, `publish-copy-${mode}`); fs.mkdirSync(dir);
    const input = makeDsf(path.join(dir, 'song.dsf'));
    const original = fs.readFileSync(input); const backend = mockBackend(); const events = [];
    const link = fs.linkSync, open = fs.promises.open;
    fs.linkSync = () => { throw Object.assign(new Error('不支持硬链接'), { code: 'ENOTSUP' }); };
    fs.promises.open = async (...args) => {
      const handle = await open(...args);
      if (args[1] === 'wx') {
        const write = handle.write.bind(handle);
        handle.write = async (buffer, offset, length, position) => {
          const result = await write(buffer, offset, Math.min(4, length), position);
          if (mode === 'error') throw Object.assign(new Error('模拟写盘错误'), { code: 'EIO' });
          backend.cancelCurrentTask(); return result;
        };
      }
      return handle;
    };
    try {
      const result = await dsd.runDsdJob(sender(events), { inputs: [input] }, { backend });
      assert.equal(result.done, 0); assert.equal(result.cancelled, mode === 'cancel');
      assert.deepEqual(fs.readFileSync(input), original);
      assert.deepEqual(fs.readdirSync(dir), ['song.dsf']);
      assert.equal(events.some((e) => e.type === 'file-done'), false);
    } finally { fs.linkSync = link; fs.promises.open = open; }
  }
});

test('发布期间源文件变化会丢弃输出；取消不会删除已被他人替换的目标', async () => {
  for (const mode of ['source-change', 'replacement']) {
    const dir = path.join(temp, `publish-${mode}`); fs.mkdirSync(dir);
    const input = makeDsf(path.join(dir, 'song.dsf')); const output = path.join(dir, 'song.flac');
    const backend = mockBackend(); const events = []; const link = fs.linkSync;
    fs.linkSync = (sourceFile, destination) => {
      link(sourceFile, destination);
      if (mode === 'source-change') fs.appendFileSync(input, '来源变动');
      else {
        fs.unlinkSync(destination); fs.writeFileSync(destination, '其他程序的文件');
        backend.cancelCurrentTask();
      }
    };
    try {
      const result = await dsd.runDsdJob(sender(events), { inputs: [input] }, { backend });
      assert.equal(result.done, 0); assert.equal(result.cancelled, mode === 'replacement');
      if (mode === 'source-change') assert.equal(fs.existsSync(output), false);
      else assert.equal(fs.readFileSync(output, 'utf8'), '其他程序的文件');
      assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.ffgui-dsd-')), false);
      assert.equal(events.some((e) => e.type === 'file-done'), false);
    } finally { fs.linkSync = link; }
  }
});
