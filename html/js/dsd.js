// DSD 转 PCM：渲染层只管理队列与表单，真实文件头、命令行和输出防覆盖由主进程处理。
// 文件名、路径、探测结果和错误日志一律使用 textContent 写入。
(function () {
  const RATES = new Set([88200, 176400, 352800, 96000, 192000, 384000]);
  const state = {
    items: [], activeItems: [], running: false, cancelling: false,
    picking: false, pickingDir: false, outputDir: '', logLines: [],
  };
  const el = (id) => document.getElementById(id);
  const els = {
    back: el('btn-back'), add: el('btn-add-files'), clear: el('btn-clear-files'),
    panel: el('file-panel'), list: el('file-list'), count: el('file-count'), hint: el('queue-hint'),
    format: el('sel-format'), rate: el('sel-sample-rate'), depth: el('sel-bit-depth'),
    floatOption: el('option-float'), gain: el('input-gain'), metadata: el('copy-metadata'),
    cover: el('copy-cover'), formatHint: el('format-hint'), outdir: el('input-outdir'),
    pickDir: el('btn-pick-dir'), resetDir: el('btn-reset-dir'), start: el('btn-start'),
    cancel: el('btn-cancel'), status: el('status-text'), bar: el('progress-bar'),
    track: el('progress-track'), log: el('log-area'),
  };

  function baseName(path) { return String(path).split(/[\\/]/).pop(); }
  function pathKey(path) {
    return window.ffgui.platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path;
  }
  function message(err) { return String(err && err.message || err || '未知错误'); }
  function node(tag, className, text) {
    const out = document.createElement(tag);
    if (className) out.className = className;
    if (text !== undefined) out.textContent = text;
    return out;
  }
  function duration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '时长未知';
    const value = Math.floor(seconds);
    return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60]
      .map((part) => String(part).padStart(2, '0')).join(':');
  }
  function log(text) {
    state.logLines.push(String(text));
    if (state.logLines.length > 300) state.logLines.splice(0, state.logLines.length - 300);
    els.log.textContent = state.logLines.join('\n');
    els.log.classList.remove('hidden');
    els.log.scrollTop = els.log.scrollHeight;
  }
  function readyItems() { return state.items.filter((item) => item.info && !item.probeError); }
  function probing() { return state.items.some((item) => item.status === 'probing'); }
  function expectedOutput(item) {
    if (!item.info) return '';
    const rate = els.rate.value === 'auto' ? item.info.targetRate : Number(els.rate.value);
    const depth = els.depth.value === '32f' ? '32-bit 浮点' : '24-bit 整数';
    return `预期：${rate / 1000} kHz / ${depth} · ${els.format.value.toUpperCase()}`;
  }

  function updateItem(item) {
    if (!item.dom) return;
    const dom = item.dom;
    dom.status.className = `file-status ${item.status}`;
    dom.status.textContent = item.statusText;
    dom.target.textContent = expectedOutput(item);
    dom.output.textContent = item.output ? `已输出：${item.output}` : '';
    dom.output.classList.toggle('hidden', !item.output);
    dom.warning.textContent = item.error || item.warning || '';
    dom.warning.classList.toggle('hidden', !dom.warning.textContent);
    dom.remove.disabled = state.running;
  }

  function renderItems() {
    els.list.replaceChildren();
    if (!state.items.length) {
      els.list.appendChild(node('li', 'file-list-empty', '将 DSF / DFF 文件拖到这里，或点击“添加 DSF / DFF…”'));
    }
    for (const item of state.items) {
      const row = node('li', 'dsd-file-item');
      const details = node('div', 'dsd-file-details');
      const name = node('span', 'dsd-file-name', baseName(item.path));
      name.title = item.path;
      const info = item.info;
      const source = info
        ? `${info.container.toUpperCase()} · DSD${info.dsdLevel} · ${info.dsdRate / 1000000} MHz`
          + ` · ${info.channels} 声道 · ${duration(info.duration)}`
          + (info.family === 48000 ? ' · 48 kHz 家族' : '')
          + (info.compression === 'DST' ? ' · DST 压缩' : '')
        : (item.probeError ? '无法读取 DSD 规格' : '正在读取文件中的真实 DSD 规格…');
      details.appendChild(name);
      details.appendChild(node('p', 'dsd-file-source', source));
      const target = node('p', 'dsd-file-target');
      const output = node('p', 'dsd-file-output');
      const warning = node('p', 'dsd-file-warning');
      details.appendChild(target);
      details.appendChild(output);
      details.appendChild(warning);
      const status = node('span', 'file-status');
      const remove = node('button', 'file-remove', '×');
      remove.type = 'button';
      remove.title = '移除此文件';
      remove.setAttribute('aria-label', `移除 ${baseName(item.path)}`);
      remove.addEventListener('click', () => {
        if (state.running) return;
        state.items = state.items.filter((entry) => entry !== item);
        renderItems();
        updateControls();
      });
      row.appendChild(details);
      row.appendChild(status);
      row.appendChild(remove);
      els.list.appendChild(row);
      item.dom = { status, target, output, warning, remove };
      updateItem(item);
    }
    updateControls();
  }

  function updateControls() {
    const pending = probing();
    const count = readyItems().length;
    const errors = state.items.filter((item) => item.probeError).length;
    els.count.textContent = state.items.length ? `（${state.items.length}）` : '';
    els.hint.textContent = pending ? '正在读取文件规格，完成后可开始转换。'
      : errors ? `${count} 个文件可转换，${errors} 个文件探测失败；开始时将跳过失败项。`
      : '支持批量选择或拖入 DSF / DFF 文件。每个文件按真实规格确定自动输出采样率。';
    els.start.disabled = state.running || pending || state.picking || state.pickingDir || !count;
    els.start.textContent = count ? `开始转换（${count} 个）` : '开始转换';
    els.start.classList.toggle('hidden', state.running);
    els.cancel.classList.toggle('hidden', !state.running);
    els.cancel.disabled = state.cancelling;
    els.cancel.textContent = state.cancelling ? '正在取消…' : '取消';
    els.add.disabled = state.running || state.picking;
    els.clear.disabled = state.running || !state.items.length;
    els.back.disabled = state.running;
    for (const control of [els.format, els.rate, els.depth, els.gain, els.metadata]) {
      control.disabled = state.running;
    }
    els.cover.disabled = state.running || els.format.value !== 'flac';
    els.pickDir.disabled = state.running || state.pickingDir;
    els.resetDir.disabled = state.running || state.pickingDir;
    els.resetDir.classList.toggle('hidden', !state.outputDir);
    for (const item of state.items) if (item.dom) item.dom.remove.disabled = state.running;
  }

  function updateFormat() {
    const flac = els.format.value === 'flac';
    els.floatOption.disabled = flac;
    if (flac && els.depth.value === '32f') els.depth.value = '24';
    els.formatHint.textContent = flac
      ? 'FLAC 输出使用 24-bit 整数；32-bit 浮点仅适用于 WAV。'
      : 'WAV 可选 24-bit 整数或用于后续编辑的 32-bit 浮点。WAV 输出不写入内嵌封面。';
    for (const item of state.items) updateItem(item);
    updateControls();
  }

  // 每批探测保留条目身份：清空或移除后，迟到的结果不能把文件重新加回来。
  async function addFiles(paths) {
    if (state.running || !Array.isArray(paths)) return;
    const known = new Set(state.items.map((item) => pathKey(item.path)));
    const added = [];
    let skipped = 0;
    for (const path of paths) {
      if (typeof path !== 'string' || !/\.(dsf|dff)$/i.test(path)) { skipped++; continue; }
      const key = pathKey(path);
      if (known.has(key)) continue;
      known.add(key);
      added.push({ path, info: null, probeError: false, status: 'probing',
        statusText: '读取规格…', percent: 0, output: '', error: '', warning: '' });
    }
    if (skipped) log(`已忽略 ${skipped} 个不支持的文件，仅接受 DSF / DFF。`);
    if (!added.length) return;
    state.items.push(...added);
    renderItems();
    els.status.textContent = `正在读取 ${added.length} 个文件的规格…`;
    try {
      const results = await window.ffgui.dsdProbe(added.map((item) => item.path));
      const byPath = new Map((Array.isArray(results) ? results : [])
        .filter((info) => info && typeof info.path === 'string')
        .map((info) => [pathKey(info.path), info]));
      for (const item of added) {
        if (!state.items.includes(item)) continue;
        const info = byPath.get(pathKey(item.path));
        if (!info || info.error) {
          item.probeError = true;
          item.status = 'error';
          item.statusText = '探测失败';
          item.error = info ? message(info.error) : '没有收到此文件的探测结果';
        } else if (!['dsf', 'dff'].includes(info.container)
          || ![64, 128, 256, 512].includes(info.dsdLevel)
          || ![44100, 48000].includes(info.family)
          || info.dsdRate !== info.family * info.dsdLevel
          || !Number.isInteger(info.channels) || info.channels < 1 || !RATES.has(info.targetRate)) {
          item.probeError = true;
          item.status = 'error';
          item.statusText = '探测失败';
          item.error = 'DSD 规格不受支持或探测结果不完整';
        } else {
          item.info = info;
          item.status = 'pending';
          item.statusText = '待转换';
        }
      }
    } catch (err) {
      for (const item of added) {
        if (!state.items.includes(item)) continue;
        item.probeError = true;
        item.status = 'error';
        item.statusText = '探测失败';
        item.error = message(err);
      }
    } finally {
      renderItems();
      // 新任务可能已在最后一个待探测条目被移除后启动，不覆盖其进度文案。
      if (!state.running && !probing()) {
        els.status.textContent = readyItems().length
          ? `已就绪：${readyItems().length} 个文件` : '请添加可读取的 DSD 文件';
      }
    }
  }

  function currentJob() {
    const format = els.format.value;
    const sampleRate = els.rate.value === 'auto' ? 'auto' : Number(els.rate.value);
    const bitDepth = els.depth.value;
    const gainDb = Number(els.gain.value);
    if (!['flac', 'wav'].includes(format)) throw new Error('请选择 FLAC 或 WAV');
    if (sampleRate !== 'auto' && !RATES.has(sampleRate)) throw new Error('请选择支持的采样率');
    if (!['24', '32f'].includes(bitDepth) || (format === 'flac' && bitDepth === '32f')) {
      throw new Error('FLAC 只支持整数输出；32-bit 浮点请选择 WAV');
    }
    if (!els.gain.value.trim() || !Number.isFinite(gainDb) || gainDb < -12 || gainDb > 6) {
      throw new Error('增益必须在 -12 到 +6 dB 之间');
    }
    return {
      inputs: readyItems().map((item) => item.path), outputDir: state.outputDir,
      format, sampleRate, bitDepth, gainDb,
      copyMetadata: els.metadata.checked, copyCover: format === 'flac' && els.cover.checked,
    };
  }

  function setProgress() {
    const percent = state.activeItems.length
      ? state.activeItems.reduce((sum, item) => sum + item.percent, 0) / state.activeItems.length : 0;
    const value = Math.max(0, Math.min(100, percent));
    els.bar.style.setProperty('--progress-width', `${value}%`);
    els.track.setAttribute('aria-valuenow', String(Math.round(value)));
  }

  function handleEvent(evt) {
    if (!state.running || !evt || typeof evt !== 'object') return;
    // 优先匹配路径，防止共享进度通道上其他输入的事件误更新当前队列。
    const item = typeof evt.input === 'string'
      ? state.activeItems.find((entry) => pathKey(entry.path) === pathKey(evt.input))
      : (Number.isInteger(evt.index) ? state.activeItems[evt.index] : null);
    if (!item) return;
    const index = state.activeItems.indexOf(item);
    const phase = evt.phase === 'scan' ? '检查峰值' : '转换';
    if (evt.type === 'file-start' || evt.type === 'progress') {
      if (item.status === 'done' || item.status === 'error' || item.status === 'cancelled') return;
      const stagePercent = Number.isFinite(evt.percent) ? Math.max(0, Math.min(99, evt.percent)) : 0;
      // 两阶段均由后端执行；阶段末尾仍等待最终 file-done 确认文件已发布。
      const percent = evt.phase === 'scan' ? stagePercent / 2 : 50 + stagePercent / 2;
      item.percent = Math.max(item.percent, percent);
      item.status = 'running';
      item.statusText = state.cancelling ? '正在取消…' : `${phase} ${Math.round(stagePercent)}%`;
      if (!state.cancelling) {
        els.status.textContent = `（${index + 1}/${state.activeItems.length}）${baseName(item.path)} · ${phase}`
          + (evt.type === 'progress' ? ` ${Math.round(stagePercent)}%` : '…');
      }
    } else if (evt.type === 'file-done') {
      item.status = 'done';
      item.statusText = '完成';
      item.percent = 100;
      item.output = evt.output || '';
      log(`✔ ${baseName(item.path)} → ${item.output}`);
    } else if (evt.type === 'file-warning') {
      item.warning = message(evt.warning);
      log(`提示：${baseName(item.path)}：${item.warning}`);
    } else if (evt.type === 'file-error') {
      item.status = evt.cancelled ? 'cancelled' : 'error';
      item.statusText = evt.cancelled ? '已取消' : '失败';
      item.error = message(evt.error);
      if (!evt.cancelled) item.percent = 100;
      log(`${evt.cancelled ? '已取消' : '失败'}：${baseName(item.path)}：${item.error}`);
    } else {
      return;
    }
    updateItem(item);
    setProgress();
  }

  async function startConvert() {
    if (state.running || probing() || state.picking || state.pickingDir || !readyItems().length) return;
    let job;
    try { job = currentJob(); }
    catch (err) { els.status.textContent = message(err); return; }
    state.running = true;
    state.cancelling = false;
    state.activeItems = readyItems().slice();
    state.logLines = [];
    els.log.textContent = '';
    els.log.classList.add('hidden');
    for (const item of state.activeItems) {
      item.status = 'pending';
      item.statusText = '等待处理';
      item.percent = 0;
      item.output = '';
      item.error = '';
      item.warning = '';
      updateItem(item);
    }
    els.status.textContent = '正在准备转换…';
    setProgress();
    updateControls();
    let off;
    try {
      off = window.ffgui.onConvertEvent(handleEvent);
      const result = await window.ffgui.dsdConvert(job);
      const cancelled = Boolean(result && result.cancelled);
      for (const item of state.activeItems) {
        if (item.status !== 'pending' && item.status !== 'running') continue;
        item.status = cancelled ? 'cancelled' : 'error';
        item.statusText = cancelled ? '已取消' : '失败';
        item.error = cancelled ? '' : '未收到文件完成确认，请检查转换日志';
        if (!cancelled) item.percent = 100;
        updateItem(item);
      }
      const done = state.activeItems.filter((item) => item.status === 'done').length;
      const failed = state.activeItems.filter((item) => item.status === 'error').length;
      els.status.textContent = cancelled
        ? `已取消：完成 ${done}/${state.activeItems.length}` + (failed ? `，失败 ${failed}` : '')
        : `处理结束：成功 ${done}/${state.activeItems.length}` + (failed ? `，失败 ${failed}` : '');
    } catch (err) {
      for (const item of state.activeItems) {
        if (item.status !== 'pending' && item.status !== 'running') continue;
        item.status = 'error';
        item.statusText = '未完成';
        item.error = message(err);
        updateItem(item);
      }
      log(`转换失败：${message(err)}`);
      els.status.textContent = `转换失败：${message(err)}`;
    } finally {
      if (typeof off === 'function') off();
      state.running = false;
      state.cancelling = false;
      setProgress();
      updateControls();
    }
  }

  async function cancelConvert() {
    if (!state.running || state.cancelling) return;
    state.cancelling = true;
    els.status.textContent = '正在取消，等待当前任务结束…';
    updateControls();
    const activeItems = state.activeItems;
    try { await window.ffgui.cancelConvert(); }
    catch (err) {
      // 旧批次迟到的取消失败不能改变新批次状态。
      if (!state.running || state.activeItems !== activeItems) return;
      log(`取消请求失败：${message(err)}`);
      state.cancelling = false;
      els.status.textContent = '取消请求失败，可重试取消';
      updateControls();
    }
  }

  els.back.addEventListener('click', () => { if (!state.running) window.location.href = 'index.html'; });
  window.addEventListener('beforeunload', (event) => {
    if (state.running) { event.preventDefault(); event.returnValue = ''; }
  });
  els.add.addEventListener('click', async () => {
    if (state.running || state.picking) return;
    state.picking = true;
    updateControls();
    try { await addFiles(await window.ffgui.dsdPickFiles()); }
    catch (err) { log(`添加文件失败：${message(err)}`); }
    finally { state.picking = false; updateControls(); }
  });
  els.clear.addEventListener('click', () => {
    if (state.running) return;
    state.items = [];
    state.activeItems = [];
    els.status.textContent = '请添加 DSD 文件';
    setProgress();
    renderItems();
  });
  els.pickDir.addEventListener('click', async () => {
    if (state.running || state.pickingDir) return;
    state.pickingDir = true;
    updateControls();
    try {
      const directory = await window.ffgui.pickDirectory();
      if (directory && !state.running) { state.outputDir = directory; els.outdir.value = directory; }
    } catch (err) { log(`选择输出目录失败：${message(err)}`); }
    finally { state.pickingDir = false; updateControls(); }
  });
  els.resetDir.addEventListener('click', () => {
    if (state.running || state.pickingDir) return;
    state.outputDir = '';
    els.outdir.value = '';
    updateControls();
  });
  els.format.addEventListener('change', updateFormat);
  for (const control of [els.rate, els.depth]) {
    control.addEventListener('change', () => { for (const item of state.items) updateItem(item); });
  }
  els.start.addEventListener('click', startConvert);
  els.cancel.addEventListener('click', cancelConvert);

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
  els.panel.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!state.running) els.panel.classList.add('drag-over');
  });
  els.panel.addEventListener('dragleave', (event) => {
    if (!els.panel.contains(event.relatedTarget)) els.panel.classList.remove('drag-over');
  });
  els.panel.addEventListener('drop', async (event) => {
    event.preventDefault();
    els.panel.classList.remove('drag-over');
    if (state.running) return;
    const paths = [];
    for (const file of Array.from(event.dataTransfer && event.dataTransfer.files || [])) {
      try {
        const path = window.ffgui.getPathForFile(file);
        if (path) paths.push(path);
        else log(`无法读取文件路径：${file.name || '未知文件'}`);
      } catch (err) { log(`无法读取拖入文件：${message(err)}`); }
    }
    await addFiles(paths);
  });

  renderItems();
  updateFormat();
})();
