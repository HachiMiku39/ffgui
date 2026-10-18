// 光盘抓取页逻辑
// 来源：ISO 镜像 / 已提取目录（discPickSource）+ 物理光驱（discListDrives）；
// 探测（discProbe）返回标题列表，默认只选最长标题；每个标题可单独挑选音轨与
// 字幕轨。选轨语义：null=全部保留，[]=一条都不保留，非空数组=只保留指定轨。
// 任务经 discStart 提交，进度经 onDiscEvent 推送。
// 安全约束：盘上卷标/语言/编码等不可信字符串一律用 textContent 写入，绝不拼接
// HTML 字符串；渲染层只传路径与轨号这类数据，FFmpeg 命令行由主进程拼装。
(function () {
  // ---------- 纯逻辑开始（node:test 按标记整段提取，此段不得引用 DOM） ----------
  const MODES = [
    { value: 'copy', label: '无损 MKV（复制视频流，最快）' },
    { value: 'transcode', label: '转码（重新编码）' },
  ];

  // 输出方式 -> 可用格式：无损模式仅 MKV，转码可选 MKV / MP4
  const MODE_FORMATS = { copy: ['mkv'], transcode: ['mkv', 'mp4'] };

  const FORMAT_LABELS = { mkv: 'MKV', mp4: 'MP4' };

  // copy 仅 MKV；transcode/MKV 音频可 copy 或 aac；transcode/MP4 音频只能 aac
  const AUDIO_OPTIONS = {
    copy: [{ value: 'copy', label: '直接复制（不重编码）' }],
    'transcode-mkv': [
      { value: 'copy', label: '直接复制（不重编码）' },
      { value: 'aac', label: 'AAC' },
    ],
    'transcode-mp4': [{ value: 'aac', label: 'AAC（MP4 必须重编码）' }],
  };

  // MP4 容器不支持的图像字幕编码：出现时必须由用户主动把该标题字幕设为「不保留」
  const IMAGE_SUBTITLE_CODECS = new Set(['pgssub', 'pgs', 'dvd_subtitle', 'dvdsub', 'vobsub', 'xsub']);

  // null=全部、[]=不保留、非空=指定轨；其他值一律拒绝
  function normalizeTrackIds(value) {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value)) throw new Error('选轨必须是数组或 null');
    const ids = [];
    for (const v of value) {
      if (typeof v !== 'string' || v === '') throw new Error('选轨序号必须是非空字符串');
      if (!ids.includes(v)) ids.push(v);
    }
    return ids;
  }

  // 输出方式 -> 可用格式；未知方式返回 null
  function formatsForMode(mode) {
    const list = MODE_FORMATS[mode];
    return list ? list.slice() : null;
  }

  // 输出方式 + 格式 -> 可用音频编码
  function audioOptionsFor(mode, format) {
    if (mode === 'copy') return AUDIO_OPTIONS.copy;
    if (format === 'mp4') return AUDIO_OPTIONS['transcode-mp4'];
    return AUDIO_OPTIONS['transcode-mkv'];
  }

  // 默认选中的标题：时长最长的那一个（并列取第一个，忽略时长非法的条目）
  function defaultSelectedTitleIds(titles) {
    let best = null;
    let bestMs = -Infinity;
    for (const t of titles) {
      const ms = t && t.durationMs;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) continue;
      if (ms > bestMs) { bestMs = ms; best = t; }
    }
    return best ? [best.id] : [];
  }

  function hasImageSubtitles(title) {
    if (!title || !Array.isArray(title.subtitles)) return false;
    return title.subtitles.some((s) => IMAGE_SUBTITLE_CODECS.has(String(s && s.codec).toLowerCase()));
  }

  // 构造提交给主进程的单个标题条目（只含数据，不含任何命令片段）
  function buildTitleEntry(titleState) {
    const title = titleState.title;
    return {
      titleId: title.id,
      titleFingerprint: title.fingerprint,
      audioTrackIds: titleState.audio,
      subtitleTrackIds: titleState.subs,
    };
  }

  // 依据表单值与选轨结果构造任务（纯函数）
  function buildJob(options) {
    return {
      id: options.id || null,
      source: options.source,
      keydbPath: options.keydbPath || null,
      outputDir: options.outputDir,
      mode: options.mode,
      format: options.format,
      quality: options.quality,
      audioCodec: options.audioCodec,
      titles: (options.titles || []).filter((t) => t && t.selected).map(buildTitleEntry),
    };
  }

  // 提交前的整体校验：返回中文错误列表，空数组表示可以开始
  function validateJob(job, titleStates) {
    const errors = [];
    if (!job || typeof job !== 'object') return ['任务无效'];
    if (!job.source || !job.source.path) errors.push('请先选择光盘来源');
    if (!job.outputDir) errors.push('请选择输出目录');
    if (!Array.isArray(job.titles) || job.titles.length === 0) errors.push('请至少勾选一个标题');
    if (!formatsForMode(job.mode) || !formatsForMode(job.mode).includes(job.format)) {
      errors.push('输出方式与格式不兼容');
    }
    if (job.mode === 'transcode' && job.format === 'mp4' && job.audioCodec !== 'aac') {
      errors.push('MP4 输出必须把音频编码设为 AAC');
    }
    if (job.mode === 'copy' && job.audioCodec !== 'copy') {
      errors.push('无损模式只能直接复制音频流');
    }

    const byId = new Map((titleStates || []).map((t) => [t.title.id, t]));
    for (const entry of job.titles || []) {
      const st = byId.get(entry.titleId);
      if (!st) {
        errors.push(`标题 ${entry.titleId} 不存在`);
        continue;
      }
      if (entry.audioTrackIds === undefined) errors.push(`标题 ${st.title.id} 未选择音轨`);
      if (entry.subtitleTrackIds === undefined) errors.push(`标题 ${st.title.id} 未选择字幕`);
      if (!st.selected) errors.push(`标题 ${st.title.id} 未勾选`);
      // 轨号必须真实存在于该标题的流列表里，防止越界或被伪造
      const check = (ids, streams, what) => {
        if (!Array.isArray(ids)) return; // null=全部，无需逐一核对
        const known = new Set((streams || []).map((s) => String(s.id)));
        for (const id of ids) {
          if (!known.has(String(id))) errors.push(`标题 ${st.title.id} 的${what}轨 ${id} 不存在`);
        }
      };
      check(entry.audioTrackIds, st.title.audio, '音');
      check(entry.subtitleTrackIds, st.title.subtitles, '字幕');
      // MP4 输出不写入任何字幕：每个勾选标题都必须显式选择「不保留」（[]）
      if (job.format === 'mp4') {
        const subs = entry.subtitleTrackIds;
        if (!Array.isArray(subs) || subs.length > 0) {
          const reason = hasImageSubtitles(st.title)
            ? 'MP4 不支持 PGS / VobSub 图像字幕'
            : 'MP4 输出不保留字幕';
          errors.push(`${reason}：标题 ${st.title.id} 需主动把字幕设为「不保留」`);
        }
      }
    }
    return errors;
  }

  // ---------- 格式化 ----------
  function formatDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '--:--:--';
    const s = Math.floor(ms / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '--';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
  }

  function formatSpeed(bps) {
    return `${formatBytes(bps)}/s`;
  }

  function formatEta(secs) {
    if (typeof secs !== 'number' || !Number.isFinite(secs) || secs < 0) return '--';
    const s = Math.floor(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function passLabel(pass) {
    if (typeof pass !== 'string' || !pass.trim()) return '';
    const name = pass.trim();
    const labels = { mux: '封装', sync: '同步', verify: '校验', sweep: '扫描' };
    return `阶段：${labels[name.toLowerCase()] || name}`;
  }

  // 轨道显示文案：语言 / 编码 / 标签（全部来自盘上元数据，不可信）
  function streamLabel(stream) {
    const parts = [];
    const lang = stream && stream.language ? String(stream.language) : '';
    if (lang) parts.push(lang);
    if (stream && stream.codec) parts.push(String(stream.codec));
    const label = stream && stream.label ? String(stream.label) : '';
    if (label && label !== lang) parts.push(label);
    return parts.length > 0 ? parts.join(' · ') : '未知轨道';
  }

  function baseName(p) {
    return String(p).split(/[\\/]/).pop();
  }
  // ---------- 纯逻辑结束 ----------

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    back: $('btn-back'),
    pickIso: $('btn-pick-iso'),
    pickFolder: $('btn-pick-folder'),
    selDrive: $('sel-drive'),
    refreshDrives: $('btn-refresh-drives'),
    driveHint: $('drive-hint'),
    sourceName: $('source-name'),
    clearSource: $('btn-clear-source'),
    probe: $('btn-probe'),
    keydbInput: $('input-keydb'),
    pickKeydb: $('btn-pick-keydb'),
    clearKeydb: $('btn-clear-keydb'),
    titlesPanel: $('titles-panel'),
    discMeta: $('disc-meta'),
    titleList: $('title-list'),
    selectLongest: $('btn-select-longest'),
    selectAllTitles: $('btn-select-all-titles'),
    selectNoneTitles: $('btn-select-none-titles'),
    outputPanel: $('output-panel'),
    mode: $('sel-mode'),
    format: $('sel-format'),
    itemQuality: $('item-quality'),
    quality: $('sel-quality'),
    audioCodec: $('sel-audio-codec'),
    outdir: $('input-outdir'),
    pickDir: $('btn-pick-dir'),
    actionPanel: $('action-panel'),
    start: $('btn-start'),
    cancel: $('btn-cancel'),
    status: $('status-text'),
    startHint: $('start-hint'),
    progressBar: $('progress-bar'),
    log: $('log-area'),
  };

  const state = {
    source: null,        // { kind:'iso'|'folder'|'drive', path, label }
    drives: [],          // 物理光驱候选
    drivesSupported: false,
    disc: null,          // discProbe 结果
    keydbPath: null,
    outputDir: null,
    titles: [],          // { title, selected, audio, subs, row }
    probing: false,
    running: false,
    jobId: null,
    loadTicket: 0,       // 探测序号：忽略过期回调
  };

  function log(text) {
    els.log.classList.remove('hidden');
    els.log.textContent += text + '\n';
    els.log.scrollTop = els.log.scrollHeight;
  }

  function errText(err) {
    return String((err && err.message) || err);
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  // ---------- 来源 ----------
  async function refreshDrives() {
    els.refreshDrives.disabled = true;
    els.driveHint.textContent = '正在枚举物理光驱…';
    els.selDrive.disabled = true;
    els.selDrive.textContent = '';
    try {
      const res = await window.ffgui.discListDrives();
      state.drives = Array.isArray(res && res.drives) ? res.drives : [];
      state.drivesSupported = !(res && res.code);
      if (!state.drivesSupported) {
        els.driveHint.textContent = '当前环境不支持枚举物理光驱'
          + `${res && res.code ? `（${res.code}）` : ''}，请改用「选择 ISO 镜像」或「选择已提取目录」。`;
        return;
      }
      if (state.drives.length === 0) {
        els.driveHint.textContent = '未检测到物理光驱，可改用「选择 ISO 镜像」或「选择已提取目录」。';
        return;
      }
      els.driveHint.textContent = '选择光驱后点击「开始探测」；读取过程中请保持光盘在位。';
      els.selDrive.disabled = false;
      for (const d of state.drives) {
        const opt = document.createElement('option');
        opt.value = String(d.path);
        // 盘上卷标不可信：只作为文本节点写入
        opt.textContent = d.label && d.label !== d.path ? `${d.label}（${d.path}）` : String(d.path);
        els.selDrive.appendChild(opt);
      }
    } catch (err) {
      state.drivesSupported = false;
      state.drives = [];
      els.driveHint.textContent = `枚举物理光驱失败：${errText(err)}，请改用 ISO 镜像或已提取目录。`;
    } finally {
      els.refreshDrives.disabled = false;
      updateButtons();
    }
  }

  function currentSource() {
    if (state.source) return state.source;
    // 未显式选择时，光驱下拉即为当前来源
    if (state.drivesSupported && els.selDrive.value) {
      return { kind: 'drive', path: els.selDrive.value, label: null };
    }
    return null;
  }

  function sourceKindName(kind) {
    if (kind === 'iso') return 'ISO 镜像';
    if (kind === 'folder') return '已提取目录';
    if (kind === 'drive') return '物理光驱';
    return '来源';
  }

  function renderSource() {
    const src = currentSource();
    if (src) {
      const name = src.label && src.label !== src.path
        ? `${baseName(src.path)}（${src.label}）`
        : baseName(src.path);
      els.sourceName.textContent = `${sourceKindName(src.kind)}：${name}`;
      els.sourceName.title = String(src.path);
      els.clearSource.classList.remove('hidden');
    } else {
      els.sourceName.textContent = '尚未选择来源';
      els.sourceName.title = '';
      els.clearSource.classList.add('hidden');
    }
    updateButtons();
  }

  function confirmDiscard() {
    return window.confirm('切换来源会清空已探测到的标题与选轨设置，确定继续吗？');
  }

  async function setSource(source) {
    // 任务进行中不允许切换来源（避免输出互相覆盖或选轨错乱）
    if (state.running) {
      log('任务进行中，请先取消或等待完成后再切换来源');
      return;
    }
    // 探测进行中直接禁止切换：否则旧探测结果会渲染到新来源上
    if (state.probing) {
      log('正在探测光盘，请等待探测结束再切换来源');
      return;
    }
    if (source && state.disc && !confirmDiscard()) return;
    state.source = source;
    resetDisc();
    renderSource();
  }

  function resetDisc() {
    state.disc = null;
    state.titles = [];
    els.titleList.textContent = '';
    els.discMeta.textContent = '';
    els.titlesPanel.classList.add('hidden');
    els.outputPanel.classList.add('hidden');
    els.actionPanel.classList.add('hidden');
    els.progressBar.style.setProperty('--progress-width', '0%');
    setStatus('');
    els.startHint.textContent = '';
    updateButtons();
  }

  // ---------- 探测 ----------
  async function probeSource() {
    if (state.probing) return;
    const src = currentSource();
    if (!src) {
      setStatus('请先选择 ISO 镜像、已提取目录或物理光驱');
      return;
    }
    if (state.disc && !confirmDiscard()) return;
    const ticket = ++state.loadTicket;
    state.probing = true;
    updateButtons();
    setStatus('正在探测光盘…');
    log(`开始探测：${baseName(src.path)}`);

    try {
      const disc = await window.ffgui.discProbe(src);
      if (ticket !== state.loadTicket) return; // 期间又换了来源
      if (!disc || !Array.isArray(disc.titles)) throw new Error('探测结果不含标题列表');
      state.disc = disc;
      renderDisc(disc);
      els.titlesPanel.classList.remove('hidden');
      els.outputPanel.classList.remove('hidden');
      els.actionPanel.classList.remove('hidden');
      setStatus(`探测完成，共 ${disc.titles.length} 个标题`);
      log(`探测完成：${disc.titles.length} 个标题`);
    } catch (err) {
      if (ticket !== state.loadTicket) return;
      resetDisc();
      setStatus('探测失败');
      log(`✘ 探测失败：${errText(err)}`);
    } finally {
      if (ticket === state.loadTicket) {
        state.probing = false;
        updateButtons();
      }
    }
  }

  function renderDisc(disc) {
    els.discMeta.textContent = '';
    const addTag = (text, extraClass) => {
      const tag = document.createElement('span');
      tag.className = `disc-meta-tag${extraClass ? ` ${extraClass}` : ''}`;
      tag.textContent = text;
      els.discMeta.appendChild(tag);
    };
    addTag(`格式：${String(disc.format || '未知')}`);
    if (disc.label) addTag(`卷标：${String(disc.label)}`);
    if (disc.encrypted) addTag('加密光盘（可能需要密钥库）', 'encrypted');

    const defaults = new Set(defaultSelectedTitleIds(disc.titles));
    els.titleList.textContent = '';
    state.titles = disc.titles.map((title) => {
      const entry = {
        title,
        selected: defaults.has(title.id),
        audio: null, // null=全部音轨
        subs: null,  // null=全部字幕
        row: null,
      };
      entry.row = createTitleRow(entry);
      els.titleList.appendChild(entry.row.root);
      return entry;
    });
    updateFormatOptions();
    updateButtons();
  }

  function createTitleRow(entry) {
    const title = entry.title;
    const root = document.createElement('li');
    root.className = 'disc-title';

    const head = document.createElement('label');
    head.className = 'disc-title-head';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = entry.selected;

    const name = document.createElement('span');
    name.className = 'disc-title-name';
    name.textContent = `标题 ${String(title.id)}`;

    const meta = document.createElement('span');
    meta.className = 'disc-title-meta';
    const bits = [formatDuration(title.durationMs)];
    if (title.sizeBytes) bits.push(formatBytes(title.sizeBytes));
    if (Number.isFinite(Number(title.chapters))) bits.push(`${title.chapters} 章`);
    meta.textContent = bits.join(' · ');

    const stateEl = document.createElement('span');
    stateEl.className = 'disc-title-state';
    stateEl.textContent = '';

    head.append(box, name, meta, stateEl);
    root.appendChild(head);

    // 音轨/字幕组：标题未勾选时整体隐藏，勾选后才显示「全部 / 全不 / 逐项」
    const groups = [
      createTrackGroup(entry, 'audio', '音轨', title.audio || [], box),
      createTrackGroup(entry, 'subtitle', '字幕', title.subtitles || [], box),
    ];
    const tracks = document.createElement('div');
    tracks.className = 'disc-tracks';
    for (const g of groups) tracks.appendChild(g.root);
    root.appendChild(tracks);

    box.addEventListener('change', () => {
      if (state.running) { box.checked = entry.selected; return; }
      entry.selected = box.checked;
      for (const g of groups) g.applyVisible();
      updateButtons();
    });

    return {
      root, box, meta, stateEl,
      setSelected(checked) {
        entry.selected = checked;
        box.checked = checked;
        for (const g of groups) g.applyVisible();
      },
    };
  }

  // 单个轨道组：「全部」= null（保留所有轨），「全不」= []，逐项勾选=指定轨
  function createTrackGroup(entry, kind, label, streams, titleBox) {
    const root = document.createElement('div');
    root.className = 'disc-track-group';

    const head = document.createElement('div');
    head.className = 'disc-track-group-head';
    const headLabel = document.createElement('span');
    headLabel.textContent = `${label}（${streams.length} 条）`;
    const bulk = document.createElement('span');
    bulk.className = 'disc-track-bulk';
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'btn';
    allBtn.textContent = '全部';
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.className = 'btn';
    noneBtn.textContent = '全不';
    bulk.append(allBtn, noneBtn);
    head.append(headLabel, bulk);

    const options = document.createElement('div');
    options.className = 'disc-track-options';
    const boxes = [];
    if (streams.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'disc-track-empty';
      empty.textContent = '无可用轨道';
      options.appendChild(empty);
    } else {
      for (const stream of streams) {
        const line = document.createElement('label');
        line.className = 'disc-track';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = true; // 默认全部保留
        const text = document.createElement('span');
        text.className = 'disc-track-text';
        // 语言/编码/标签全部来自盘上元数据，只写文本节点
        const labelText = streamLabel(stream);
        text.textContent = labelText;
        text.title = labelText;
        line.append(box, text);
        options.appendChild(line);
        boxes.push({ stream, box });
      }
    }

    const sync = () => {
      const ids = boxes.filter((b) => b.box.checked).map((b) => String(b.stream.id));
      // 一条都不勾选 -> []；全部勾选也返回显式数组，交给 normalizeTrackIds 归一
      if (kind === 'audio') entry.audio = normalizeTrackIds(ids);
      else entry.subs = normalizeTrackIds(ids);
      updateButtons();
    };
    allBtn.addEventListener('click', () => {
      if (state.running) return;
      for (const b of boxes) b.box.checked = true;
      sync();
    });
    noneBtn.addEventListener('click', () => {
      if (state.running) return;
      for (const b of boxes) b.box.checked = false;
      sync();
    });
    for (const b of boxes) b.box.addEventListener('change', sync);

    const applyVisible = () => { root.classList.toggle('hidden', !titleBox.checked); };

    root.classList.add('hidden');
    return { root, applyVisible };
  }

  function setTitleState(entry, text, cls) {
    entry.row.stateEl.textContent = text;
    entry.row.stateEl.classList.remove('running', 'done', 'error');
    if (cls) entry.row.stateEl.classList.add(cls);
  }

  // ---------- 输出设置 ----------
  function currentMode() {
    return els.mode.value === 'copy' ? 'copy' : 'transcode';
  }

  function currentFormat() {
    return els.format.value === 'mp4' ? 'mp4' : 'mkv';
  }

  function fillSelect(select, items, value) {
    select.textContent = '';
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      select.appendChild(opt);
    }
    if (items.some((it) => it.value === value)) select.value = value;
  }

  function updateFormatOptions() {
    const mode = currentMode();
    fillSelect(els.mode, MODES, mode);
    const formats = formatsForMode(mode) || [];
    const wanted = formats.includes(currentFormat()) ? currentFormat() : formats[0];
    fillSelect(els.format, formats.map((f) => ({ value: f, label: FORMAT_LABELS[f] || f })), wanted);
    const audio = audioOptionsFor(mode, wanted);
    const audioWanted = audio.some((o) => o.value === els.audioCodec.value)
      ? els.audioCodec.value
      : audio[0].value;
    fillSelect(els.audioCodec, audio, audioWanted);
    els.itemQuality.classList.toggle('hidden', mode === 'copy');
    updateButtons();
  }

  // ---------- 校验与按钮 ----------
  function selectedTitles() {
    return state.titles.filter((t) => t.selected);
  }

  function currentJob() {
    return buildJob({
      id: state.jobId,
      source: currentSource(),
      keydbPath: state.keydbPath,
      outputDir: state.outputDir,
      mode: currentMode(),
      format: currentFormat(),
      quality: els.quality.value,
      audioCodec: els.audioCodec.value,
      titles: selectedTitles(),
    });
  }

  function jobErrors() {
    return validateJob(currentJob(), state.titles);
  }

  function canStart() {
    return jobErrors().length === 0;
  }

  function updateStartHint() {
    const errors = jobErrors();
    if (state.running) {
      els.startHint.textContent = '任务进行中：切换来源、改选轨或离开页面都会被拦截。';
      return;
    }
    if (errors.length > 0) {
      els.startHint.textContent = errors[0];
      return;
    }
    els.startHint.textContent = `将抓取 ${selectedTitles().length} 个标题，输出到所选目录。`;
  }

  function updateButtons() {
    // 探测进行中同样锁住来源相关入口，避免探测结果与来源不一致
    els.probe.disabled = state.probing || state.running || !currentSource();
    els.refreshDrives.disabled = state.probing || state.running;
    els.clearSource.classList.toggle('hidden', !state.source || state.running);
    els.clearSource.disabled = state.probing || state.running;
    els.clearKeydb.classList.toggle('hidden', !state.keydbPath || state.running);
    els.pickIso.disabled = state.probing || state.running;
    els.pickFolder.disabled = state.probing || state.running;
    els.pickKeydb.disabled = state.running;
    els.selDrive.disabled = state.probing || state.running || !state.drivesSupported
      || state.drives.length === 0;
    els.mode.disabled = state.running;
    els.format.disabled = state.running;
    els.quality.disabled = state.running;
    els.audioCodec.disabled = state.running;
    els.pickDir.disabled = state.running;
    for (const btn of [els.selectLongest, els.selectAllTitles, els.selectNoneTitles]) {
      btn.disabled = state.running || state.titles.length === 0;
    }
    els.start.disabled = state.running || state.probing || !canStart();
    els.cancel.classList.toggle('hidden', !state.running);
    updateStartHint();
  }

  // ---------- 任务 ----------
  async function startJob() {
    if (state.running) return; // 防重复提交
    const errors = jobErrors();
    if (errors.length > 0) {
      updateButtons();
      return;
    }
    const job = currentJob();
    state.running = true;
    state.jobId = `disc-${Date.now()}`;
    for (const t of state.titles) setTitleState(t, '', null);
    els.log.classList.add('hidden');
    els.log.textContent = '';
    els.progressBar.style.setProperty('--progress-width', '0%');
    setStatus('正在提交抓取任务…');
    log(`开始抓取 ${job.titles.length} 个标题`
      + `（${job.mode === 'copy' ? '无损 MKV' : `转码 ${FORMAT_LABELS[job.format]}`}）`);
    updateButtons();

    const off = window.ffgui.onDiscEvent((evt) => handleDiscEvent(evt));
    try {
      const result = await window.ffgui.discStart({ ...job, id: state.jobId });
      const width = els.progressBar.style.getPropertyValue('--progress-width');
      els.progressBar.style.setProperty('--progress-width', result.done >= result.total ? '100%' : width);
      setStatus(result.cancelled
        ? '已取消'
        : (result.done >= result.total ? '抓取完成' : '抓取失败，详见日志'));
      if (!result.cancelled && result.errors && result.errors.length > 0) {
        log(`✘ ${result.errors.length} 个标题失败`);
      }
    } catch (err) {
      log(`✘ 抓取失败：${errText(err)}`);
      setStatus('抓取失败');
    } finally {
      off();
      state.running = false;
      state.jobId = null;
      updateButtons();
    }
  }

  function handleDiscEvent(evt) {
    if (!evt || typeof evt.type !== 'string') return;
    switch (evt.type) {
      case 'start':
        setStatus(`开始抓取，共 ${evt.total} 个标题`);
        break;
      case 'title-start': {
        const entry = state.titles.find((t) => t.title.id === evt.titleId);
        if (entry) setTitleState(entry, evt.phase === 'rip' ? '抓取中…' : '转码中…', 'running');
        const phase = evt.phase === 'rip' ? '抓取' : '转码';
        setStatus(`${phase}标题 ${evt.titleId}（${Number(evt.index) + 1}）`);
        if (evt.output) log(`— 标题 ${evt.titleId} ${phase}开始 → ${evt.output}`);
        break;
      }
      case 'progress': {
        const entry = state.titles.find((t) => t.title.id === evt.titleId);
        let percent = Number(evt.percent);
        if (!Number.isFinite(percent)) percent = 0;
        // 抓取阶段以字节进度为准（主进程此时可能只给 bytesDone / bytesTotal）
        const bytesDone = Number(evt.bytesDone);
        const bytesTotal = Number(evt.bytesTotal);
        if (evt.phase === 'rip' && percent <= 0 && bytesDone > 0 && bytesTotal > 0) {
          percent = (bytesDone / bytesTotal) * 100;
        }
        percent = Math.max(0, Math.min(100, Math.round(percent)));
        if (entry) entry.row.stateEl.textContent = `${percent}%`;
        els.progressBar.style.setProperty('--progress-width', `${percent}%`);
        const parts = [`${percent}%`];
        if (evt.time && evt.duration) {
          parts.push(`${formatDuration(evt.time * 1000)}/${formatDuration(evt.duration * 1000)}`);
        }
        if (evt.bytesDone) parts.push(formatBytes(evt.bytesDone));
        if (evt.bytesTotal) parts.push(`/ ${formatBytes(evt.bytesTotal)}`);
        if (evt.speedBps) parts.push(formatSpeed(evt.speedBps));
        if (evt.etaSecs) parts.push(`剩余 ${formatEta(evt.etaSecs)}`);
        // pass 是 mux / sync / verify 这类阶段名，不是「第几遍」
        const stage = passLabel(evt.pass);
        if (stage) parts.push(stage);
        setStatus(`${evt.phase === 'rip' ? '抓取' : '转码'}标题 ${evt.titleId}：${parts.join('  ')}`);
        break;
      }
      case 'title-done': {
        const entry = state.titles.find((t) => t.title.id === evt.titleId);
        if (entry) setTitleState(entry, '完成', 'done');
        if (evt.output) log(`✔ 标题 ${evt.titleId} 完成 → ${evt.output}`);
        break;
      }
      case 'title-error': {
        const entry = state.titles.find((t) => t.title.id === evt.titleId);
        if (entry) setTitleState(entry, '失败', 'error');
        log(`✘ 标题 ${evt.titleId} 失败：${evt.code}${evt.params ? ` ${JSON.stringify(evt.params)}` : ''}`);
        break;
      }
      case 'log':
        if (evt.message) log(String(evt.message));
        break;
      case 'done':
        log(`任务结束：完成 ${evt.done}/${evt.total}${evt.cancelled ? '（已取消）' : ''}`);
        break;
      default:
        break;
    }
  }

  // ---------- 事件绑定 ----------
  els.back.addEventListener('click', () => {
    if (state.running) {
      log('任务进行中，请先取消或等待完成后再返回首页');
      return;
    }
    window.location.href = 'index.html';
  });
  els.pickIso.addEventListener('click', async () => {
    if (state.running || state.probing) return;
    const res = await window.ffgui.discPickSource('iso');
    if (res && res.path) await setSource({ kind: 'iso', path: res.path, label: res.label || null });
  });
  els.pickFolder.addEventListener('click', async () => {
    if (state.running || state.probing) return;
    const res = await window.ffgui.discPickSource('folder');
    if (res && res.path) await setSource({ kind: 'folder', path: res.path, label: res.label || null });
  });
  els.selDrive.addEventListener('change', async () => {
    if (state.running || state.probing) return;
    const path = els.selDrive.value;
    if (!path) return;
    const drive = state.drives.find((d) => String(d.path) === path);
    await setSource({ kind: 'drive', path, label: (drive && drive.label) || null });
  });
  els.refreshDrives.addEventListener('click', refreshDrives);
  els.clearSource.addEventListener('click', async () => {
    if (state.running || state.probing) return;
    if (state.disc && !confirmDiscard()) return;
    state.source = null;
    resetDisc();
    renderSource();
  });
  els.pickKeydb.addEventListener('click', async () => {
    if (state.running) return;
    const p = await window.ffgui.discPickKeydb();
    if (p) {
      state.keydbPath = p;
      els.keydbInput.value = p;
      updateButtons();
    }
  });
  els.clearKeydb.addEventListener('click', () => {
    if (state.running) return;
    state.keydbPath = null;
    els.keydbInput.value = '';
    updateButtons();
  });
  els.probe.addEventListener('click', probeSource);
  els.selectLongest.addEventListener('click', () => {
    if (state.running) return;
    const keep = new Set(defaultSelectedTitleIds(state.titles.map((t) => t.title)));
    for (const t of state.titles) t.row.setSelected(keep.has(t.title.id));
    updateButtons();
  });
  els.selectAllTitles.addEventListener('click', () => {
    if (state.running) return;
    for (const t of state.titles) t.row.setSelected(true);
    updateButtons();
  });
  els.selectNoneTitles.addEventListener('click', () => {
    if (state.running) return;
    for (const t of state.titles) t.row.setSelected(false);
    updateButtons();
  });
  els.mode.addEventListener('change', updateFormatOptions);
  els.format.addEventListener('change', updateFormatOptions);
  els.pickDir.addEventListener('click', async () => {
    if (state.running) return;
    const dir = await window.ffgui.pickDirectory();
    if (dir) {
      state.outputDir = dir;
      els.outdir.value = dir;
      updateButtons();
    }
  });
  els.start.addEventListener('click', startJob);
  els.cancel.addEventListener('click', () => {
    window.ffgui.discCancel(state.jobId);
    setStatus('正在取消…');
    log('已请求取消，等待当前标题结束…');
  });

  // 任务进行中阻止离开页面（beforeunload 无对话框，仅拦截卸载）
  window.addEventListener('beforeunload', (e) => {
    if (state.running) {
      e.preventDefault();
      e.returnValue = false;
      setStatus('正在抓取中，请先取消或等待完成再离开页面');
    }
  });

  refreshDrives();
  renderSource();
})();
