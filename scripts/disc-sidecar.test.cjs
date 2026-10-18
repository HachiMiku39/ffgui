'use strict';

// 运行：node --test scripts/disc-sidecar.test.cjs
// main/disc-sidecar.js 侧车协议客户端的单元测试：用 EventEmitter mock 子进程，
// 不依赖真实侧车二进制与 ffmpeg。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  createDiscSidecar,
  runDiscSidecar,
  DiscSidecarError,
  MAX_LINE_BYTES,
} = require('../main/disc-sidecar.js');

const VERSION = 1;
const ID = 'job-1';
const REQUEST = {
  version: VERSION,
  id: ID,
  method: 'probe',
  params: { source: { kind: 'iso', path: 'C:/media/disc.iso' } },
};

function event(type, extra = {}) {
  return { version: VERSION, id: ID, type, ...extra };
}

// 假子进程：stdin/stdout/stderr 均为 PassThrough，可手动灌数据与派发 close
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killCalls = [];
    this.stdinWritten = [];
    this.stdin.on('data', (chunk) => this.stdinWritten.push(chunk.toString()));
  }

  kill(signal) {
    this.killCalls.push(signal || 'SIGTERM');
    return true;
  }

  close(code, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }

  fail(err) {
    this.emit('error', err);
  }

  writeStdout(data) {
    this.stdout.write(data);
  }

  writeStderr(data) {
    this.stderr.write(data);
  }

  ndjson(obj) {
    this.writeStdout(JSON.stringify(obj) + '\n');
  }

  sentRequests() {
    return this.stdinWritten.map((t) => JSON.parse(t)).filter((o) => o && o.id === ID);
  }
}

function harness(options = {}) {
  const children = [];
  const events = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = new FakeChild();
    child.spawnCmd = cmd;
    child.spawnArgs = args;
    child.spawnOpts = opts;
    children.push(child);
    return child;
  };
  const sidecar = createDiscSidecar({
    executable: 'disc-sidecar',
    request: REQUEST,
    spawnImpl,
    onEvent: (ev) => events.push(ev),
    ...options,
  });
  const run = sidecar.run();
  return { sidecar, run, children, events };
}

async function expectReject(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('期望 promise 被 reject');
}

test('完整 probe：初始请求写出、事件转发、result 后 close 0 解析出结果', async () => {
  const { run, children, events } = harness();
  await Promise.resolve();
  const child = children[0];
  assert.equal(child.spawnCmd, 'disc-sidecar');
  assert.deepEqual(child.spawnOpts.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(child.sentRequests(), [REQUEST]);

  child.ndjson(event('progress', { phase: 'ripping', bytesDone: 10, bytesTotal: 100, speedBps: 5, etaSecs: 18 }));
  child.ndjson(event('log', { level: 'info', code: 'disc.detected', params: { label: 'TEST' } }));
  child.ndjson(event('result', { result: { ok: true, tracks: 3 } }));
  assert.equal(events.length, 3);
  assert.equal(events[2].type, 'result');
  child.close(0);

  assert.deepEqual(await run, { ok: true, tracks: 3 });
  // run() 复用同一个 promise：重复调用不会重新 spawn 或重复 settle
  const again = await run;
  assert.deepEqual(again, { ok: true, tracks: 3 });
  assert.equal(children.length, 1);
});

test('分块与粘包：事件跨 chunk 拆分、多事件合并仍逐条解析', async () => {
  const { run, children, events } = harness();
  await Promise.resolve();
  const child = children[0];
  const full = [
    JSON.stringify(event('progress', { phase: 'probe', bytesDone: 1, bytesTotal: 2 })),
    JSON.stringify(event('progress', { phase: 'probe', bytesDone: 2, bytesTotal: 2 })),
    JSON.stringify(event('result', { result: { done: true } })),
  ].join('\n') + '\n';

  child.writeStdout(full.slice(0, 5));
  child.writeStdout(full.slice(5, 9));
  child.writeStdout(full.slice(9));
  assert.equal(events.length, 3, '粘包与拆分都必须完整解析');
  child.close(0);
  assert.deepEqual(await run, { done: true });
});

test('CRLF 与空行：\r\n 结尾与空行被容忍', async () => {
  const { run, children, events } = harness();
  await Promise.resolve();
  const child = children[0];
  child.writeStdout('\r\n');
  child.ndjson(event('result', { result: { value: 'ok' } }));
  child.writeStdout('   \n');
  assert.equal(events.length, 1);
  child.close(0);
  assert.deepEqual(await run, { value: 'ok' });
});

test('Unicode：非 ASCII 与多字节字符跨 chunk 拆分不损坏', async () => {
  const { run, children, events } = harness();
  await Promise.resolve();
  const child = children[0];
  const line = JSON.stringify(event('log', { level: 'info', code: '标题：白菜VLOG✨ 日本' })) + '\n';
  const buf = Buffer.from(line, 'utf8');
  const cut = buf.indexOf(Buffer.from('白')) + 1;
  child.writeStdout(buf.subarray(0, cut));
  child.writeStdout(buf.subarray(cut));
  assert.equal(events.length, 1);
  assert.equal(events[0].code, '标题：白菜VLOG✨ 日本');
  child.ndjson(event('result', { result: { name: '结果✨' } }));
  child.close(0);
  assert.deepEqual(await run, { name: '结果✨' });
});

test('非法 JSON：解析失败以 bad-json reject', async () => {
  const { run, children } = harness();
  await Promise.resolve();
  const child = children[0];
  child.writeStdout('{"version":1,"id":"job-1","type":"progress"\n');
  const err = await expectReject(run);
  assert.equal(err.code, 'bad-json');
  assert.ok(err instanceof DiscSidecarError);
  assert.ok(child.killCalls.length >= 1, '协议错误必须终止子进程');
});

test('超大行：超过单行上限以 line-too-large reject', async () => {
  const { run, children } = harness();
  await Promise.resolve();
  const child = children[0];
  const padding = 'x'.repeat(MAX_LINE_BYTES + 100);
  child.writeStdout(JSON.stringify({ version: 1, id: ID, type: 'progress', phase: padding }) + '\n');
  const err = await expectReject(run);
  assert.equal(err.code, 'line-too-large');
  assert.ok(err instanceof DiscSidecarError);
});

test('未终结缓冲超过上限：buffer-overflow', async () => {
  const { run, children } = harness();
  await Promise.resolve();
  const child = children[0];
  child.writeStdout('y'.repeat(MAX_LINE_BYTES + 10));
  const err = await expectReject(run);
  assert.equal(err.code, 'line-too-large');
});

test('错误 version / id：bad-version 与 bad-id', async () => {
  const a = harness();
  await Promise.resolve();
  a.children[0].ndjson({ version: 2, id: ID, type: 'progress' });
  assert.equal((await expectReject(a.run)).code, 'bad-version');

  const b = harness();
  await Promise.resolve();
  b.children[0].ndjson({ version: VERSION, id: 'other-job', type: 'progress' });
  assert.equal((await expectReject(b.run)).code, 'bad-id');
});

test('未知事件类型：unknown-type', async () => {
  const { run, children } = harness();
  await Promise.resolve();
  children[0].ndjson({ version: VERSION, id: ID, type: 'bogus' });
  const err = await expectReject(run);
  assert.equal(err.code, 'unknown-type');
  assert.equal(err.params.type, 'bogus');
});

test('终态结构校验：缺 result 的 result 事件与缺 code 的 error 事件', async () => {
  const a = harness();
  await Promise.resolve();
  a.children[0].ndjson({ version: VERSION, id: ID, type: 'result' });
  assert.equal((await expectReject(a.run)).code, 'bad-result');

  const b = harness();
  await Promise.resolve();
  b.children[0].ndjson({ version: VERSION, id: ID, type: 'error', error: {} });
  assert.equal((await expectReject(b.run)).code, 'bad-error');
});

test('额外字段前向兼容：未知字段被透传', async () => {
  const { run, children, events } = harness();
  await Promise.resolve();
  const child = children[0];
  child.ndjson(event('progress', { phase: 'x', bytesDone: 1, bytesTotal: 2, futureField: { a: 1 } }));
  assert.equal(events[0].futureField.a, 1);
  child.ndjson(event('result', { result: { ok: 1 }, extra: 'kept' }));
  child.close(0);
  assert.deepEqual(await run, { ok: 1 });
});

test('stderr tail：失败错误带上有界 stderr 且保留尾部', async () => {
  const { run, children } = harness();
  await Promise.resolve();
  const child = children[0];
  child.writeStderr('早期日志'.repeat(10));
  child.writeStderr('关键诊断信息');
  child.close(1);
  const err = await expectReject(run);
  assert.ok(err.stderr.endsWith('关键诊断信息'));
  assert.ok(err.stderr.length <= 8000);
});

test('进程 error：spawn 失败以 spawn-error reject', async () => {
  const { run, children } = harness();
  await Promise.resolve();
  const child = children[0];
  const err0 = new Error('ENOENT');
  err0.code = 'ENOENT';
  child.fail(err0);
  const err = await expectReject(run);
  assert.equal(err.code, 'spawn-error');
  assert.equal(err.params.code, 'ENOENT');
  assert.equal(err.cause, err0);
  // error 之后再 close 不会重复 settle
  child.close(1);
  await run.catch(() => {});
});

test('close 0 但无 result：missing-result', async () => {
  const { run, children, events } = harness();
  await Promise.resolve();
  children[0].ndjson(event('progress', { phase: 'x', bytesDone: 0, bytesTotal: 0 }));
  children[0].close(0);
  const err = await expectReject(run);
  assert.equal(err.code, 'missing-result');
  assert.equal(err.exitCode, 0);
  assert.equal(events.length, 1);
});

test('result 之后非 0 close：以进程最终状态判定为失败', async () => {
  const { run, children } = harness();
  await Promise.resolve();
  const child = children[0];
  child.ndjson(event('result', { result: { ok: true } }));
  child.close(3);
  const err = await expectReject(run);
  assert.equal(err.code, 'exit-nonzero');
  assert.equal(err.exitCode, 3);
  assert.equal(err.params.resultReceived, true);
});

test('无 result 且非 0 close：exit-nonzero', async () => {
  const { run, children } = harness();
  await Promise.resolve();
  children[0].close(2);
  const err = await expectReject(run);
  assert.equal(err.code, 'exit-nonzero');
  assert.equal(err.exitCode, 2);
});

test('error 终态：带 code/params reject 且不再等待 close', async () => {
  const { run, children, events } = harness();
  await Promise.resolve();
  const child = children[0];
  child.ndjson(event('error', { error: { code: 'disc.unreadable', params: { sector: 1234 } } }));
  const err = await expectReject(run);
  assert.equal(err.code, 'disc.unreadable');
  assert.deepEqual(err.params, { sector: 1234 });
  assert.equal(err.message, '侧车报告错误 disc.unreadable');
  // 之后迟到的 progress 与 close 都被忽略，也不会再产生事件
  child.ndjson(event('progress', { phase: 'late' }));
  child.close(0);
  await run.catch(() => {});
  assert.equal(events.length, 0);
});

test('cancel 宽限：先写 cancel，宽限期后 kill，重复 cancel 幂等', async () => {
  const created = harness({ cancelGraceMs: 5 });
  await Promise.resolve();
  const child = created.children[0];
  assert.equal(child.killCalls.length, 0);
  created.sidecar.cancel();
  created.sidecar.cancel();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(child.killCalls.length, 1, '宽限期后恰好 kill 一次');
  assert.equal(child.sentRequests().filter((r) => r.method === 'cancel').length, 1, 'cancel 请求只写一次');
  child.close(null, 'SIGTERM');
  const err = await expectReject(created.run);
  assert.equal(err.code, 'cancelled');
  assert.equal(err.params.signal, 'SIGTERM');
});

test('cancel 宽限内退出：不调用 kill', async () => {
  const created = harness({ cancelGraceMs: 50 });
  await Promise.resolve();
  const child = created.children[0];
  created.sidecar.cancel({ graceMs: 50 });
  await new Promise((r) => setTimeout(r, 10));
  child.close(0);
  const err = await expectReject(created.run);
  assert.equal(err.code, 'cancelled');
  assert.equal(child.killCalls.length, 0);
});

test('强制 kill：宽限期后仍存活则再次 kill', async () => {
  const created = harness({ cancelGraceMs: 5, forceKillMs: 5 });
  await Promise.resolve();
  const child = created.children[0];
  created.sidecar.cancel();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);
  child.close(null, 'SIGKILL');
  const err = await expectReject(created.run);
  assert.equal(err.code, 'cancelled');
});

test('result 到达后 cancel 无效', async () => {
  const created = harness({ cancelGraceMs: 5 });
  await Promise.resolve();
  const child = created.children[0];
  child.ndjson(event('result', { result: { value: 'done' } }));
  created.sidecar.cancel();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(child.killCalls.length, 0);
  child.close(0);
  assert.deepEqual(await created.run, { value: 'done' });
});

test('cancel 后 stdin 已关闭时不再写入', async () => {
  const created = harness({ cancelGraceMs: 5 });
  await Promise.resolve();
  const child = created.children[0];
  created.sidecar.cancel();
  await new Promise((r) => setTimeout(r, 20));
  child.close(null, 'SIGTERM');
  await expectReject(created.run);
  const cancels = child.sentRequests().filter((r) => r.method === 'cancel');
  assert.equal(cancels.length, 1);
});

test('终态后迟到事件被忽略', async () => {
  const { run, children, events } = harness();
  await Promise.resolve();
  const child = children[0];
  child.ndjson(event('progress', { phase: 'early' }));
  await Promise.resolve();
  assert.equal(events.length, 1);
  child.ndjson(event('error', { error: { code: 'boom' } }));
  await expectReject(run);
  // error 是终态事件：客户端直接 reject，不把它当普通事件转发
  assert.equal(events.length, 1);
  child.ndjson(event('progress', { phase: 'late-1' }));
  child.ndjson(event('result', { result: { value: 'late' } }));
  child.writeStderr('late stderr');
  child.close(1);
  await run.catch(() => {});
  assert.equal(events.length, 1);
  assert.equal(child.killCalls.length >= 1, true, 'error 终态也要终止子进程');
});

test('onEvent 抛异常：以 event-handler-error reject', async () => {
  const created = harness({ onEvent: () => { throw new Error('boom-handler'); } });
  await Promise.resolve();
  created.children[0].ndjson(event('progress', { phase: 'x' }));
  const err = await expectReject(created.run);
  assert.equal(err.code, 'event-handler-error');
});

test('runDiscSidecar：可独立运行并返回结果', async () => {
  const children = [];
  const spawnImpl = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const run = runDiscSidecar({ executable: 'x', request: REQUEST, spawnImpl });
  await Promise.resolve();
  children[0].ndjson(event('result', { result: { via: 'helper' } }));
  children[0].close(0);
  assert.deepEqual(await run, { via: 'helper' });
});

test('参数校验：缺 executable / request 直接抛错', () => {
  assert.throws(() => createDiscSidecar({ request: REQUEST, spawnImpl: () => {} }), /executable/);
  assert.throws(() => createDiscSidecar({ executable: 'x', spawnImpl: () => {} }), /request/);
  assert.throws(() => createDiscSidecar({
    executable: 'x',
    request: { version: 1, id: '', method: 'probe' },
    spawnImpl: () => {},
  }), /request/);
});
