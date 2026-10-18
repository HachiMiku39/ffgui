'use strict';

// 音视频光盘侧车子进程（Rust 侧车）协议客户端。
// 协议约定：一个侧车子进程只处理一个初始请求，stdin/stdout 均为 NDJSON，
// stdout 只承载协议事件，stderr 仅为诊断日志（此处只保留有界 tail）。
// 本模块不涉及 Electron IPC，也不猜测侧车内部的 disc schema。

const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const DISC_SIDECAR_VERSION = 1;
// 单行上限与未终结缓冲上限：超出即视为侧车失控，终止任务
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
// 失败诊断用的 stderr tail（字符数）
const STDERR_TAIL_CHARS = 8000;
const DEFAULT_CANCEL_GRACE_MS = 3000;
// cancel 宽限内未退出则补一刀 SIGKILL 的等待时间
const DEFAULT_FORCE_KILL_MS = 5000;
const EVENT_TYPES = new Set(['progress', 'log', 'result', 'error']);

class DiscSidecarError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'DiscSidecarError';
    this.code = code;
    this.params = options.params || {};
    this.stderr = options.stderr || '';
    this.exitCode = options.exitCode;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 校验并归一化一条协议事件；允许携带额外字段以便前向兼容
function parseEventLine(line, expected) {
  let event;
  try {
    event = JSON.parse(line);
  } catch (err) {
    throw new DiscSidecarError('bad-json', '侧车输出不是合法 JSON', {
      params: { snippet: line.slice(0, 200) },
      cause: err,
    });
  }
  if (!isPlainObject(event)) {
    throw new DiscSidecarError('bad-json', '侧车输出不是 JSON 对象', {
      params: { snippet: line.slice(0, 200) },
    });
  }
  if (event.version !== expected.version) {
    throw new DiscSidecarError('bad-version', `侧车事件版本 ${event.version} 与请求版本 ${expected.version} 不一致`, {
      params: { expected: expected.version, actual: event.version },
    });
  }
  if (event.id !== expected.id) {
    throw new DiscSidecarError('bad-id', `侧车事件 id ${event.id} 与请求 id ${expected.id} 不一致`, {
      params: { expected: expected.id, actual: event.id },
    });
  }
  if (!EVENT_TYPES.has(event.type)) {
    throw new DiscSidecarError('unknown-type', `未知的侧车事件类型 ${event.type}`, {
      params: { type: event.type },
    });
  }
  if (event.type === 'result' && !isPlainObject(event.result)) {
    throw new DiscSidecarError('bad-result', 'result 事件缺少 result 对象');
  }
  if (event.type === 'error') {
    const err = event.error;
    if (!isPlainObject(err) || typeof err.code !== 'string' || !err.code) {
      throw new DiscSidecarError('bad-error', 'error 事件缺少字符串 error.code');
    }
    if ('params' in err && !isPlainObject(err.params)) {
      throw new DiscSidecarError('bad-error', 'error 事件的 error.params 不是对象');
    }
  }
  return event;
}

function killChild(child, signal) {
  if (!child || typeof child.kill !== 'function') return;
  try {
    child.kill(signal);
  } catch {
    // 进程已退出时 kill 会抛错，忽略
  }
}

function createDiscSidecar(options = {}) {
  const {
    executable,
    args = [],
    request,
    spawnImpl = spawn,
    onEvent,
    env,
    cwd,
    maxLineBytes = MAX_LINE_BYTES,
    maxBufferBytes = MAX_BUFFER_BYTES,
    cancelGraceMs = DEFAULT_CANCEL_GRACE_MS,
    forceKillMs = DEFAULT_FORCE_KILL_MS,
  } = options;

  if (typeof executable !== 'string' || !executable) {
    throw new TypeError('createDiscSidecar 需要字符串 executable');
  }
  if (!isPlainObject(request) || !Number.isFinite(request.version)
    || typeof request.id !== 'string' || !request.id
    || typeof request.method !== 'string' || !request.method) {
    throw new TypeError('createDiscSidecar 需要含 version/id/method 的 request 对象');
  }

  let child = null;
  let runPromise = null;
  let settleRun = null;
  let failRun = null;
  let settled = false;
  let cancelled = false;
  let cancelRequested = false;
  let gotResult = null;
  let stdinClosed = false;
  let stderrTail = '';
  let outBuffer = '';
  let outDecoder = new StringDecoder('utf8');
  let errDecoder = new StringDecoder('utf8');
  let graceTimer = null;
  let forceTimer = null;

  function clearTimers() {
    if (graceTimer) clearTimeout(graceTimer);
    if (forceTimer) clearTimeout(forceTimer);
    graceTimer = null;
    forceTimer = null;
  }

  // 唯一的 settle 入口：重复调用、error/close 双回调都不会产生第二次返回
  function succeed(result) {
    if (settled) return;
    settled = true;
    stdinClosed = true;
    clearTimers();
    const stdin = child && child.stdin;
    if (stdin && typeof stdin.end === 'function') {
      try {
        stdin.end();
      } catch {
        // stdin 可能已销毁
      }
    }
    settleRun(result);
  }

  function rejectWith(error) {
    if (settled) return;
    settled = true;
    stdinClosed = true;
    clearTimers();
    const stdin = child && child.stdin;
    if (stdin && typeof stdin.end === 'function') {
      try {
        stdin.end();
      } catch {
        // stdin 可能已销毁
      }
    }
    failRun(error);
  }

  function fail(code, message, extra = {}) {
    if (settled) return;
    killChild(child);
    rejectWith(new DiscSidecarError(code, message, {
      stderr: stderrTail,
      exitCode: child ? child.exitCode : undefined,
      ...extra,
    }));
  }

  function emitEvent(event) {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(event);
    } catch (err) {
      fail('event-handler-error', 'onEvent 回调抛出异常', {
        params: { type: event.type },
        cause: err,
      });
    }
  }

  function handleEventLine(line) {
    if (settled) return;
    let event;
    try {
      event = parseEventLine(line, request);
    } catch (err) {
      if (err instanceof DiscSidecarError) {
        fail(err.code, err.message, { params: err.params, cause: err.cause });
      } else {
        fail('bad-json', `解析侧车事件失败：${err && err.message ? err.message : err}`, { cause: err });
      }
      return;
    }
    if (settled) return;
    if (event.type === 'error') {
      // error 是终态：直接 reject 并终止子进程，不把 error 事件转发给 onEvent
      killChild(child);
      rejectWith(new DiscSidecarError(event.error.code, `侧车报告错误 ${event.error.code}`, {
        params: event.error.params || {},
        stderr: stderrTail,
        exitCode: child ? child.exitCode : undefined,
      }));
      return;
    }
    emitEvent(event);
    if (settled) return;
    if (event.type === 'result') {
      // result 只是"已交付"，最终成败以进程退出状态为准，故先不 settle
      gotResult = event.result;
      return;
    }
  }

  function pushStdout(text) {
    if (settled || !text) return;
    outBuffer += text;
    if (Buffer.byteLength(outBuffer) > maxBufferBytes) {
      outBuffer = '';
      fail('buffer-overflow', `侧车 stdout 未终结缓冲超过 ${maxBufferBytes} 字节`);
      return;
    }
    let nl;
    while ((nl = outBuffer.indexOf('\n')) >= 0) {
      const raw = outBuffer.slice(0, nl);
      outBuffer = outBuffer.slice(nl + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line.trim()) continue;
      if (Buffer.byteLength(raw) > maxLineBytes) {
        fail('line-too-large', `侧车 stdout 单行超过 ${maxLineBytes} 字节`);
        return;
      }
      handleEventLine(line);
      if (settled) return;
    }
    if (Buffer.byteLength(outBuffer) > maxLineBytes) {
      outBuffer = '';
      fail('line-too-large', `侧车 stdout 未终结行超过 ${maxLineBytes} 字节`);
    }
  }

  function pushStderr(text) {
    if (!text) return;
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
  }

  function onChildError(err) {
    fail('spawn-error', `无法启动侧车进程：${err && err.message ? err.message : err}`, {
      params: { code: err && err.code },
      cause: err,
    });
  }

  function onChildClose(code, signal) {
    if (settled) return;
    if (cancelled) {
      rejectWith(new DiscSidecarError('cancelled', '侧车任务已取消', {
        stderr: stderrTail,
        exitCode: code,
        params: { exitCode: code, signal },
      }));
      return;
    }
    if (gotResult) {
      if (code === 0) {
        succeed(gotResult);
        return;
      }
      rejectWith(new DiscSidecarError('exit-nonzero',
        `侧车已返回 result 但退出码为 ${code}`, {
          stderr: stderrTail,
          exitCode: code,
          params: { exitCode: code, signal, resultReceived: true },
        }));
      return;
    }
    if (code === 0) {
      rejectWith(new DiscSidecarError('missing-result', '侧车退出前未返回匹配的 result', {
        stderr: stderrTail,
        exitCode: code,
        params: { exitCode: code, signal },
      }));
      return;
    }
    rejectWith(new DiscSidecarError('exit-nonzero', `侧车以退出码 ${code} 结束且未返回 result`, {
      stderr: stderrTail,
      exitCode: code,
      params: { exitCode: code, signal },
    }));
  }

  function writeLine(obj) {
    return new Promise((resolve, reject) => {
      const stdin = child && child.stdin;
      if (!stdin || stdinClosed || stdin.writable === false || stdin.destroyed) {
        reject(new DiscSidecarError('stdin-closed', '侧车 stdin 已关闭'));
        return;
      }
      let done = false;
      const onError = (err) => {
        if (done) return;
        done = true;
        reject(err);
      };
      stdin.once('error', onError);
      try {
        stdin.write(JSON.stringify(obj) + '\n', (err) => {
          if (done) return;
          done = true;
          stdin.removeListener('error', onError);
          if (err) reject(err);
          else resolve();
        });
      } catch (err) {
        if (!done) {
          done = true;
          reject(err);
        }
      }
    });
  }

  function scheduleKill(grace) {
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (settled) return;
      killChild(child);
      forceTimer = setTimeout(() => {
        forceTimer = null;
        if (settled) return;
        if (child && child.exitCode === null && child.signalCode === null) {
          killChild(child, 'SIGKILL');
        }
      }, forceKillMs);
      if (forceTimer && typeof forceTimer.unref === 'function') forceTimer.unref();
    }, grace);
    if (graceTimer && typeof graceTimer.unref === 'function') graceTimer.unref();
  }

  function cancel(cancelOptions = {}) {
    const grace = Number.isFinite(cancelOptions.graceMs) ? cancelOptions.graceMs : cancelGraceMs;
    // 幂等：重复 cancel 不重复写请求、不重复 kill
    if (cancelRequested || settled || gotResult) return;
    cancelRequested = true;
    cancelled = true;
    if (!child) return;
    writeLine({ version: request.version, id: request.id, method: 'cancel', params: {} })
      .catch(() => {
        // 进程可能已退出，写不进去不算错误
      });
    scheduleKill(grace);
  }

  function start() {
    child = spawnImpl(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd });
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdin) stdin.on('error', () => {});
    if (stdout) stdout.on('data', (chunk) => pushStdout(outDecoder.write(chunk)));
    if (stderr) stderr.on('data', (chunk) => pushStderr(errDecoder.write(chunk)));
    child.on('error', onChildError);
    child.on('close', onChildClose);
    writeLine(request).catch((err) => {
      fail('write-failed', `写入初始请求失败：${err && err.message ? err.message : err}`, { cause: err });
    });
  }

  function run() {
    if (runPromise) return runPromise;
    runPromise = new Promise((resolve, reject) => {
      settleRun = resolve;
      failRun = reject;
    });
    start();
    return runPromise;
  }

  return { run, cancel, get child() { return child; } };
}

function runDiscSidecar(options) {
  return createDiscSidecar(options).run();
}

module.exports = {
  createDiscSidecar,
  runDiscSidecar,
  DiscSidecarError,
  DISC_SIDECAR_VERSION,
  MAX_LINE_BYTES,
  MAX_BUFFER_BYTES,
  STDERR_TAIL_CHARS,
  EVENT_TYPES,
};
