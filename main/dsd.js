'use strict';

const fs = require('fs');
const path = require('path');

const PCM_RATES = new Set([88200, 96000, 176400, 192000, 352800, 384000]);
const DSD_LEVELS = [64, 128, 256, 512];
const LOWPASS_HZ = 30000;
const MAX_CHUNKS = 16384;

function localPath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error(`${label}必须是本地文件的绝对路径`);
  }
  return path.resolve(value);
}

function normalizeInputs(files) {
  if (!Array.isArray(files) || !files.length || files.length > 1000) {
    throw new Error('请选择 1～1000 个 DSF/DFF 文件');
  }
  return files.map((file) => localPath(file, '输入'));
}

function identifyDsdRate(dsdRate) {
  for (const family of [44100, 48000]) {
    const dsdLevel = dsdRate / family;
    if (DSD_LEVELS.includes(dsdLevel)) {
      return { dsdRate, dsdLevel, family, targetRate: family * (dsdLevel === 64 ? 2 : 4) };
    }
  }
  throw new Error(`不支持的 DSD 位采样率：${dsdRate} Hz（支持 44.1/48 kHz 家族的 DSD64～512）`);
}

// 只按块读取必要的文件头，不把数 GB 的 DSD 音频载入内存。
// 所有长度先用 BigInt 检查，再转成安全整数用于文件定位。
function readDsdHeader(input) {
  const file = localPath(input, '输入');
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error('输入必须是可读取的普通文件');
    const read = (offset, length) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > stat.size) {
        throw new Error('DSD 文件头或数据块被截断');
      }
      const buf = Buffer.alloc(length);
      if (fs.readSync(fd, buf, 0, length, offset) !== length) throw new Error('DSD 文件读取不完整');
      return buf;
    };
    const size64 = (buf, endian, offset = 4) => {
      const size = endian === 'le' ? buf.readBigUInt64LE(offset) : buf.readBigUInt64BE(offset);
      if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('DSD 数据块长度超出安全范围');
      return Number(size);
    };
    const magic = read(0, 4).toString('ascii');
    let info;
    if (magic === 'DSD ') info = readDsf(read, size64, stat.size);
    else if (magic === 'FRM8') info = readDff(read, size64, stat.size);
    else throw new Error('文件内容不是 DSF/DFF；SACD ISO 请先提取为 DSF 或 DFF');
    return { path: file, ...info, ...identifyDsdRate(info.dsdRate) };
  } finally {
    fs.closeSync(fd);
  }
}

function readDsf(read, size64, fileSize) {
  const head = read(0, 28);
  if (size64(head, 'le') !== 28) throw new Error('DSF 主文件头长度无效');
  const declaredSize = size64(head, 'le', 12);
  const metadataOffset = size64(head, 'le', 20);
  if (declaredSize !== fileSize || (metadataOffset && metadataOffset >= fileSize)) {
    throw new Error('DSF 声明的文件长度或标签位置无效');
  }
  let fmt = null;
  let data = null;
  let offset = 28;
  for (let count = 0; offset < fileSize && count < MAX_CHUNKS; count++) {
    if (metadataOffset && offset >= metadataOffset) break;
    const header = read(offset, 12);
    const name = header.toString('ascii', 0, 4);
    const length = size64(header, 'le');
    if (length < 12 || length > fileSize - offset) throw new Error('DSF 数据块长度无效');
    if (name === 'fmt ') {
      if (fmt || length < 52) throw new Error('DSF 格式块无效或重复');
      const b = read(offset + 12, 40);
      if (b.readUInt32LE(0) !== 1 || b.readUInt32LE(4) !== 0) throw new Error('不支持此 DSF 格式版本');
      const channels = b.readUInt32LE(12);
      const bits = b.readUInt32LE(20);
      const sampleCount = size64(b, 'le', 24);
      const blockSize = b.readUInt32LE(32);
      if (channels < 1 || channels > 6 || ![1, 8].includes(bits) || blockSize !== 4096 || !sampleCount) {
        throw new Error('DSF 声道、位序、采样数或块大小无效');
      }
      fmt = { channels, dsdRate: b.readUInt32LE(16), sampleCount, blockSize };
    } else if (name === 'data') {
      if (data) throw new Error('DSF 包含重复数据块');
      data = { bytes: length - 12, end: offset + length };
    }
    offset += length;
    if (fmt && data) break;
  }
  if (!fmt || !data) throw new Error('DSF 缺少格式块或音频数据块');
  const required = Math.ceil(Math.ceil(fmt.sampleCount / 8) / fmt.blockSize) * fmt.blockSize * fmt.channels;
  if (data.bytes < required || (metadataOffset && metadataOffset < data.end)) {
    throw new Error('DSF 音频数据被截断或与标签重叠');
  }
  identifyDsdRate(fmt.dsdRate);
  return { container: 'dsf', compression: 'DSD', dsdRate: fmt.dsdRate,
    channels: fmt.channels, duration: fmt.sampleCount / fmt.dsdRate };
}

function readDff(read, size64, fileSize) {
  const head = read(0, 16);
  const formSize = size64(head, 'be');
  if (head.toString('ascii', 12, 16) !== 'DSD ' || formSize < 4 || formSize > fileSize - 12) {
    throw new Error('DFF FRM8 文件头无效或被截断');
  }
  const formEnd = 12 + formSize;
  let chunks = 0;
  const eachChunk = (start, end, visitor) => {
    let offset = start;
    while (offset < end) {
      if (++chunks > MAX_CHUNKS) throw new Error('DFF 数据块数量异常');
      if (end - offset < 12) throw new Error('DFF 数据块头被截断');
      const header = read(offset, 12);
      const size = size64(header, 'be');
      if (size > end - offset - 12) throw new Error('DFF 数据块超出父块边界');
      const name = header.toString('ascii', 0, 4);
      visitor(name, offset + 12, size);
      offset += 12 + size + (size % 2);
      if (offset > end) throw new Error('DFF 数据块缺少对齐字节');
    }
  };
  let dsdRate = null;
  let channels = null;
  let compression = null;
  let audioBytes = null;
  let dstDuration = null;
  eachChunk(16, formEnd, (name, offset, size) => {
    if (name === 'PROP') {
      if (size < 4 || read(offset, 4).toString('ascii') !== 'SND ') return;
      eachChunk(offset + 4, offset + size, (prop, pos, length) => {
        if (prop === 'FS  ') {
          if (length !== 4 || dsdRate !== null) throw new Error('DFF 采样率属性无效或重复');
          dsdRate = read(pos, 4).readUInt32BE(0);
        } else if (prop === 'CHNL') {
          if (length < 2 || channels !== null) throw new Error('DFF 声道属性无效或重复');
          channels = read(pos, 2).readUInt16BE(0);
          if (channels < 1 || channels > 32 || length < 2 + channels * 4) throw new Error('DFF 声道布局不完整');
        } else if (prop === 'CMPR') {
          if (length < 5 || compression !== null) throw new Error('DFF 压缩属性无效或重复');
          compression = read(pos, 4).toString('ascii').trim();
          if (!['DSD', 'DST'].includes(compression)) throw new Error('DFF 使用了不支持的压缩格式');
        }
      });
    } else if (name === 'DSD ') {
      if (audioBytes !== null || dstDuration !== null || !size) throw new Error('DFF 音频数据块无效或重复');
      audioBytes = size;
    } else if (name === 'DST ') {
      if (audioBytes !== null || dstDuration !== null) throw new Error('DFF 音频数据块重复');
      // FRTE 是 DST 的首个块；无需遍历整首曲目的 DSTF 帧即可得到准确时长。
      if (size < 18) throw new Error('DST 帧信息不完整');
      const frame = read(offset, 18);
      if (frame.toString('ascii', 0, 4) !== 'FRTE' || size64(frame, 'be') !== 6) throw new Error('DST 缺少 FRTE 帧信息');
      const frames = frame.readUInt32BE(12);
      const frameRate = frame.readUInt16BE(16);
      if (!frames || !frameRate || size === 18) throw new Error('DST 帧数、帧率或音频数据无效');
      dstDuration = frames / frameRate;
    }
  });
  if (dsdRate === null || channels === null || compression === null) throw new Error('DFF 缺少必要的音频属性');
  identifyDsdRate(dsdRate);
  if ((compression === 'DSD' && (audioBytes === null || audioBytes % channels !== 0))
      || (compression === 'DST' && dstDuration === null)) throw new Error('DFF 音频数据与压缩类型不一致');
  return { container: 'dff', compression, dsdRate, channels,
    duration: compression === 'DST' ? dstDuration : audioBytes * 8 / channels / dsdRate };
}

function probeDsdFiles(files) {
  return normalizeInputs(files).map((file) => {
    try { return readDsdHeader(file); }
    catch (err) { return { path: file, error: err.message }; }
  });
}

function normalizeDsdJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error('DSD 转换参数无效');
  const inputs = normalizeInputs(job.inputs);
  const format = job.format || 'flac';
  const bitDepth = job.bitDepth || '24';
  const sampleRate = job.sampleRate == null ? 'auto' : job.sampleRate;
  const gainDb = job.gainDb == null ? 0 : job.gainDb;
  if (!['flac', 'wav'].includes(format)) throw new Error('DSD 仅可导出 FLAC 或 PCM WAV');
  if (!['24', '32f'].includes(bitDepth) || (bitDepth === '32f' && format !== 'wav')) {
    throw new Error('成品请选择 24-bit；32-bit float 仅支持 WAV');
  }
  if (sampleRate !== 'auto' && !PCM_RATES.has(sampleRate)) throw new Error('请选择受支持的 PCM 采样率');
  if (typeof gainDb !== 'number' || !Number.isFinite(gainDb) || gainDb < -12 || gainDb > 6) {
    throw new Error('增益必须为 -12～+6 dB 的数值');
  }
  for (const key of ['copyMetadata', 'copyCover']) {
    if (job[key] != null && typeof job[key] !== 'boolean') throw new Error('标签和封面选项必须为布尔值');
  }
  return { inputs, format, bitDepth, sampleRate, gainDb,
    outputDir: job.outputDir ? localPath(job.outputDir, '输出目录') : null,
    copyMetadata: job.copyMetadata !== false, copyCover: job.copyCover !== false };
}

// 单次采样率转换内完成 FIR 低通；强制 resampling 也覆盖输入/输出速率相等的情况。
// 30 kHz 是本功能的保守播放策略，swr cutoff 定义为 -6 dB 点，不是可听带宽/音质等级。
// DSD 解码交给 FFmpeg；此处不把 ffprobe 的 sample_rate 当作 DSD 位采样率。
function pcmFilter(job, targetRate, header, quantize = false) {
  // swr 的 cutoff 以输入/输出中较低的 Nyquist 为基准。FFmpeg 的 DSD 流
  // 每个输入样本装八个位；DSD64 手动升至 384 kHz 时必须按 352.8 kHz 计算。
  const referenceRate = Math.min(targetRate, header.dsdRate / 8);
  const filters = [
    `aresample=${targetRate}:resampler=swr:filter_size=256:filter_type=kaiser:kaiser_beta=12:flags=res`
      + `:cutoff=${(2 * LOWPASS_HZ / referenceRate).toFixed(12)}:tsf=dblp:osf=dbl`,
    `volume=${job.gainDb}dB:precision=double`,
  ];
  if (quantize && job.bitDepth === '24') {
    // 这里只做最终格式量化，不再次改变采样率；24 位有效数据存放于 s32 样本槽。
    filters.push('aresample=osf=s32:output_sample_bits=24:dither_method=triangular');
  }
  return filters.join(',');
}

function buildDsdArgs(job, input, output, header, probe = {}, scan = false) {
  const targetRate = job.sampleRate === 'auto' ? header.targetRate : job.sampleRate;
  const args = ['-hide_banner', '-nostdin', '-xerror', '-n', '-i', input, '-map', '0:a:0'];
  if (scan) {
    args.push('-vn', '-sn', '-dn', '-af', pcmFilter(job, targetRate, header)
      + ',astats=reset=0:measure_perchannel=none:measure_overall=Peak_level+Number_of_samples+Number_of_NaNs+Number_of_Infs',
    '-c:a', 'pcm_f64le', '-f', 'null', '-nostats', '-progress', 'pipe:1', '-');
    return args;
  }
  const covers = job.copyCover && job.format === 'flac' ? (probe.covers || []) : [];
  for (const cover of covers) args.push('-map', `0:${cover.index}`);
  args.push('-map_metadata', job.copyMetadata ? '0' : '-1');
  if (!job.copyMetadata) args.push('-map_metadata:s:a', '-1');
  if (covers.length) {
    covers.forEach((cover, i) => {
      args.push(`-c:v:${i}`, ['png', 'mjpeg'].includes(cover.codec) ? 'copy' : 'mjpeg',
        `-disposition:v:${i}`, 'attached_pic');
    });
  } else args.push('-vn');
  args.push('-sn', '-dn', '-af', pcmFilter(job, targetRate, header, true));
  if (job.format === 'flac') {
    args.push('-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-compression_level', '8');
  } else {
    args.push('-c:a', job.bitDepth === '32f' ? 'pcm_f32le' : 'pcm_s24le', '-rf64', 'auto');
  }
  // 未传 -ac/-channel_layout，保留解码器提供的完整声道布局。
  args.push('-nostats', '-progress', 'pipe:1', output);
  return args;
}

function parsePeakStats(text) {
  const levels = [...text.matchAll(/Peak level dB:\s*([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?|-inf|inf|nan)/gi)]
    .map((match) => match[1].toLowerCase() === '-inf' ? -Infinity : Number(match[1]));
  const samples = [...text.matchAll(/Number of samples:\s*(\d+(?:\.\d+)?)/gi)].map((match) => Number(match[1]));
  const invalid = [...text.matchAll(/Number of (?:NaNs|Infs):\s*(\d+(?:\.\d+)?)/gi)].some((match) => Number(match[1]) > 0);
  return { peakDb: levels.length ? Math.max(...levels) : null,
    samples: samples.length ? Math.max(...samples) : 0, invalid };
}

function fingerprint(file) {
  const stat = fs.statSync(file);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

// 仅删除本次创建的同一个文件；目标若已被其他程序替换，绝不能按路径盲删。
function removeOwnedOutput(output, ownership) {
  if (!ownership) return;
  try {
    const current = fs.lstatSync(output, { bigint: true });
    if (current.dev === ownership.dev && current.ino === ownership.ino) fs.unlinkSync(output);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// 临时目录与目标位于同一文件系统。硬链接可原子拒绝重名；FAT/网络盘不支持
// 硬链接时用 wx 独占打开、有界分块复制，以便写盘错误或取消时准确清理自己的文件。
async function publishOutput(temporary, output, checkActive) {
  let ownership = null;
  try {
    checkActive();
    try {
      const identity = fs.statSync(temporary, { bigint: true });
      fs.linkSync(temporary, output);
      ownership = identity;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK'].includes(err.code)) throw err;
      const source = await fs.promises.open(temporary, 'r');
      let destination = null;
      try {
        checkActive();
        destination = await fs.promises.open(output, 'wx');
        ownership = fs.fstatSync(destination.fd, { bigint: true });
        const buffer = Buffer.alloc(1024 * 1024);
        while (true) {
          checkActive();
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          let offset = 0;
          while (offset < bytesRead) {
            checkActive();
            const { bytesWritten } = await destination.write(buffer, offset, bytesRead - offset, null);
            if (!bytesWritten) throw new Error('输出写入中断');
            offset += bytesWritten;
          }
        }
      } finally {
        try { if (destination) await destination.close(); }
        finally { await source.close(); }
      }
    }
    checkActive();
    return ownership;
  } catch (err) {
    try { removeOwnedOutput(output, ownership); }
    catch (cleanupError) { err.message += `；半成品清理失败：${cleanupError.message}`; }
    throw err;
  }
}

async function runDsdJob(sender, rawJob, options = {}) {
  const job = normalizeDsdJob(rawJob);
  const backend = options.backend || require('./ffmpeg');
  const lease = backend.acquireTaskLease();
  const send = (event) => {
    if (!sender.isDestroyed()) sender.send('ffgui:convert-event', event);
  };
  let done = 0;
  try {
    const reserved = new Set(job.inputs.map(backend.pathKey));
    const outputs = job.inputs.map((input) => backend.buildOutputPath(input, job.outputDir, job.format, reserved));
    for (let index = 0; index < job.inputs.length; index++) {
      if (backend.isTaskCancelled(lease)) break;
      const input = job.inputs[index];
      const output = outputs[index];
      let temporaryDir = null;
      try {
        const header = readDsdHeader(input);
        const sourceFingerprint = fingerprint(input);
        if (!fs.statSync(path.dirname(output)).isDirectory()) throw new Error('输出目录无效');
        // 仅用已有 ffmpeg -i 探测标签/封面；DSD 等级始终来自文件头。
        const probe = await backend.probeFile(input);
        if (backend.isTaskCancelled(lease)) break;
        if (!probe.hasAudio || probe.audioTracks.length !== 1) throw new Error('FFmpeg 未识别到唯一 DSD 音轨，请检查文件或解码器支持');
        if (job.copyCover && job.format === 'wav' && probe.covers.length) {
          send({ type: 'file-warning', index, input, warning: 'WAV 输出不保留内嵌封面；需要封面请选择 FLAC' });
        }
        let peakText = '';
        const stageSend = (phase) => (event) => {
          if (event.type === 'file-done') return;
          send({ ...event, input, output, phase, cancelled: event.type === 'file-error' && backend.isTaskCancelled(lease) });
        };
        const scan = await backend.runFfmpegTask({
          args: buildDsdArgs(job, input, null, header, probe, true), index, label: input, output: null,
          getDuration: () => header.duration, onStderrText: (tail) => { peakText = tail; },
          send: stageSend('scan'), taskName: 'DSD 峰值检查', lease,
        });
        if (!scan.ok || backend.isTaskCancelled(lease)) continue;
        const stats = parsePeakStats(peakText);
        if (stats.peakDb === null || Number.isNaN(stats.peakDb) || stats.peakDb === Infinity || !stats.samples || stats.invalid) {
          throw new Error('无法确认浮点峰值或输入含无效采样，未生成输出');
        }
        if (stats.peakDb > -0.00001 && job.bitDepth === '24') {
          const suggestedGain = Math.floor((job.gainDb - stats.peakDb - 0.1) * 10) / 10;
          throw new Error(`转换后的峰值为 ${stats.peakDb.toFixed(2)} dBFS，24-bit 导出会削波；请把增益降至 ${suggestedGain.toFixed(1)} dB 或更低。整张专辑建议使用相同增益`);
        }
        if (stats.peakDb > 0 && job.bitDepth === '32f') {
          send({ type: 'file-warning', index, input, warning: `峰值 ${stats.peakDb.toFixed(2)} dBFS 将保留在浮点 WAV；播放或导出整数前请降低增益` });
        }
        if (sourceFingerprint !== fingerprint(input)) throw new Error('输入文件在峰值检查期间发生变化，请重新添加');
        if (backend.isTaskCancelled(lease)) break;
        temporaryDir = fs.mkdtempSync(path.join(path.dirname(output), '.ffgui-dsd-'));
        const temporary = path.join(temporaryDir, `audio.${job.format}`);
        const converted = await backend.runFfmpegTask({
          args: buildDsdArgs(job, input, temporary, header, probe), index, label: input, output: temporary,
          getDuration: () => header.duration, send: stageSend('convert'), taskName: 'DSD 转 PCM', lease,
        });
        if (!converted.ok || backend.isTaskCancelled(lease)) continue;
        const checkActive = () => {
          if (backend.isTaskCancelled(lease)) throw new Error('已取消');
          if (sourceFingerprint !== fingerprint(input)) throw new Error('输入文件在转换或发布期间发生变化，已丢弃本次输出');
        };
        const ownership = await publishOutput(temporary, output, checkActive);
        try { checkActive(); }
        catch (err) { removeOwnedOutput(output, ownership); throw err; }
        done++;
        send({ type: 'file-done', index, input, output, phase: 'convert' });
      } catch (err) {
        send({ type: 'file-error', index, input, error: err.message, cancelled: backend.isTaskCancelled(lease) });
      } finally {
        if (temporaryDir) {
          try { fs.rmSync(temporaryDir, { recursive: true, force: true }); }
          catch (err) { send({ type: 'file-warning', index, input, warning: `临时文件清理失败：${err.message}` }); }
        }
      }
    }
    return { total: job.inputs.length, done, cancelled: backend.isTaskCancelled(lease) };
  } finally {
    backend.releaseTaskLease(lease);
  }
}

function registerDsdIpc() {
  const { ipcMain, dialog, BrowserWindow } = require('electron');
  ipcMain.handle('ffgui:dsd-pick-files', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '选择 DSD 音频文件', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'DSD 音频', extensions: ['dsf', 'dff'] }],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('ffgui:dsd-probe', (_event, files) => probeDsdFiles(files));
  ipcMain.handle('ffgui:dsd-convert', (event, job) => runDsdJob(event.sender, job));
}

module.exports = {
  registerDsdIpc, readDsdHeader, probeDsdFiles, identifyDsdRate,
  normalizeDsdJob, pcmFilter, buildDsdArgs, parsePeakStats, runDsdJob,
};
