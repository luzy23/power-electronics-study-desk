/* ============================================================
 * app.js — 电力电子学习台主逻辑
 * ============================================================ */
(function () {
  'use strict';

  const U = window.U;
  const API = window.API;
  const PROMPTS = window.PROMPTS;
  const { $, $$, esc, toast, store, md, renderMath, copyText, downloadFile, today, nowStr, uid } = U;

  /* ---------------------------------------------------------- state */
  // 学习包可勾选的内容（id / 显示名 / 输出模板）
  const PACK_PARTS = [
    { id: 'brief', name: '一句话概括', tpl: '## 一句话\n本章解决什么问题（1–2 句）。' },
    { id: 'map', name: '知识地图（思维导图）', tpl: '## 知识地图\n缩进树（最多 3 层），覆盖本章各节；每个节点后标注小节号。' },
    { id: 'outline', name: '知识点提纲', tpl: '## 知识点提纲\n按小节顺序，每节列 3–6 个要点（概念 / 公式 / 成立前提），缩进列表；比知识地图更细，可直接当复习提纲。' },
    { id: 'core', name: '核心结论', tpl: '## 核心结论（8–12 条）\n每条一句话 + 公式（LaTeX）+ 对应小节号。' },
    { id: 'deriv', name: '推导骨架', tpl: '## 推导骨架（3–5 条关键推导）\n每条：起点 → 关键假设 → 关键一步 → 结论；不展开代数。' },
    { id: 'quiz', name: '自测题 + 答案', tpl: '## 自测题（10 题：概念 3 / 计算 4 / 设计 3）\n先只给题目；答案放在最后的 <details><summary>答案要点</summary> 区块里。' },
    { id: 'sim', name: '仿真任务（LTspice）', tpl: '## 仿真任务\n- 可直接运行的 LTspice 网表（```spice 代码块，含 .tran 与关键测量 .meas）\n- 3 条观察要点：该看什么波形、验证哪个公式\n- 可选：Python 画 Bode 的脚本（matplotlib + 传递函数，```python 代码块）' },
    { id: 'errors', name: '近似与易错清单', tpl: '## 近似与易错清单\n表格：| 近似/假设 | 成立条件 | 失效后果 | 对应小节 |' },
    { id: 'terms', name: '术语表', tpl: '## 术语表\n表格：| 英文 | 中文 | 一句话解释 |' },
    { id: 'design', name: '与电源设计的连接', tpl: '## 与电源设计的连接\n3 条：本章在真实电源设计（DCDC 芯片、环路补偿、磁设计）中对应什么工作。' }
  ];
  const PACK_DEFAULT = PACK_PARTS.map(p => p.id);

  const S = {
    book: null,
    chapters: [],
    chapter: null,
    section: null,
    page: 1,
    dpi: 120,
    readerTab: 'page',
    workTab: 'pre',
    closeTab: 'four',
    sectionTexts: {},
    sectionPromises: {},
    sectionData: {},
    progress: store.get('progress', {}),
    glossary: store.get('glossary', []),
    rev: null,
    mistakes: store.get('mistakes', []),
    notes: store.get('notes', {}),
    archive: store.get('archive', {}),
    highlights: store.get('highlights', {}),
    pendingTermHl: null,
    plan: store.get('plan', {}),
    planCfg: Object.assign({ mode: 'auto', start: '', deadline: '', hours: 3, chapters: '1-9', custom: {} },
      store.get('planCfg', {})),
    prob: { qno: '', question: '' },     // 习题解答的题号/题干草稿
    probSolves: [],                      // 本章已保存的逐题解答
    done: store.get('done', {}),          // 手动标记"已学完"的章节 / Part
    customPrompts: store.get('prompts', {}),   // 自定义提示词覆盖（task -> 文本）
    pos: store.get('pos', {}),
    expanded: Object.assign({}, store.get('expanded', {})),
    outs: {},
    drafts: { close: '', formula: '', cards: '', ask: '' },
    selectedText: '',
    selContext: '',
    selRect: null,
    termCache: {},
    practice: { q: '', a: '', fb: '', type: '混合', n: 3, level: '标准', useProbs: true },
    feynman: { topic: '', text: '', q: '', a: '', diag: '' },
    pack: Object.assign({ scope: 'chapter', parts: PACK_DEFAULT.slice() }, store.get('pack', {})),
    quiz: { q: '', a: '', fb: '' },
    chat: { first: '', msgs: [], display: [] },
    qa: { first: '', msgs: [], display: [], useText: true, useChapter: false },
    ui: Object.assign({ sideW: 264, readerW: 0, showSide: true, showWork: true, showTop: true, spread: 'single', hlColor: 'yellow', imgScale: 0.5, autoBackup: true },
      store.get('ui', {})),
    busy: false,
    abort: null
  };
  S.ui = Object.assign({ sideW: 264, readerW: 0, showSide: true, showWork: true, showTop: true, spread: 'single', hlColor: 'yellow', imgScale: 0.5, autoBackup: true }, store.get('ui', {}));

  /* ---------------------------------------------------------- helpers */
  const CHAPTER_TARGET = 9;

  // 每节生成的内容，按小节存档，方便以后复习
  const ARCH_KEYS = ['pre', 'preAnswers', 'close', 'formula', 'cards', 'pack',
    'practiceQ', 'practiceFB', 'feynmanQ', 'feynmanDiag',
    'probSolve', 'probAll', 'chSummary'];
  const ARCH_LABEL = {
    pre: '读前预习', preAnswers: '读前解答', close: '四栏精读', formula: '公式拆解',
    cards: '术语卡', pack: '学习包', practiceQ: '练习题目', practiceFB: '练习批改',
    feynmanQ: '费曼提问', feynmanDiag: '费曼诊断',
    probSolve: '习题解答', probAll: '习题全解', chSummary: '章节提纲',
    probSolves: '习题解答集'
  };
  const ARCH_MAX = 3.2 * 1024 * 1024;   // 估算字符上限，超出时淘汰最旧的存档

  function saveProgress() { store.set('progress', S.progress); scheduleAutoBackup(); }
  function saveDone() { store.set('done', S.done); scheduleAutoBackup(); }
  function savePack() { store.set('pack', S.pack); }
  function savePrompts() { store.set('prompts', S.customPrompts || {}); scheduleAutoBackup(); }

  function saveProbSolve(sol) {
    const rec = {
      id: 'ps' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      qno: sol.qno || '未编号', question: sol.question || '',
      text: sol.text || '', ts: nowStr()
    };
    const list = (S.probSolves || []).filter(x => String(x.qno) !== String(rec.qno));
    list.push(rec);
    S.probSolves = list;
    saveArchive({ probSolves: list });
  }
  function saveGlossary() { store.set('glossary', S.glossary); scheduleAutoBackup(); }
  function wbFlagGet() { return store.get('wordbookV1', false); }
  function wbFlagSet() { store.set('wordbookV1', true); }
  function wbV2Get() { return store.get('wordbookV2', false); }
  function wbV2Set() { store.set('wordbookV2', true); }

  /* ---------------------------------------------------------- 单词本 */
  const WB_CAT_NAMES = { term: '专业术语', word: '普通词', phrase: '短语/搭配', abbr: '缩写/符号' };
  const WB_TECH_HINTS = ['converter','inverter','inductor','capacitor','resistor','transistor','diode','switch','switching','rectifier','transformer','winding','core','flux','saturation','ripple','duty cycle','volt-second','charge balance','small-ripple','steady-state','transient','small-signal','large-signal','state-space','state space','transfer function','bode','pole','zero','feedback','loop','stability','compensator','modulator','pwm','pulse-width','pulse width','mosfet','bjt','igbt','rms','dcm','ccm','buck','boost','cuk','flyback','forward converter','resonant','soft switching','zero voltage','zero current','efficiency','loss','conduction','switching loss','equivalent circuit','averaging','linearization','perturbation','magnetics','inductance','capacitance','impedance','admittance','harmonic','fourier','laplace','gain','phase margin','crossover','frequency response','thermal','filter','diode bridge','semiconductor','amplifier','oscillator','sampling','quantization'];
  function wbCatName(id) { return WB_CAT_NAMES[id] || '专业术语'; }
  function wbCleanTerm(s) {
    return String(s == null ? '' : s)
      .replace(/^[\s"'“”‘’(),.;:…\-–—]+/, '')
      .replace(/[\s"'“”‘’(),.;:…\-–—]+$/, '')
      .replace(/\s+/g, ' ').trim();
  }

  function wbIsAbbr(t) {
    const s = String(t || '').trim();
    if (!s) return false;
    if (/^[A-Z0-9+\-/.&]{2,10}$/.test(s) && /[A-Z]{2}/.test(s)) return true;
    if (/^[A-Za-z]{1,8}\d+[A-Za-z0-9]*$/.test(s)) return true;
    return false;
  }
  function wbIsPhrase(t) { return /[\s\-]/.test(String(t || '').trim()); }
  function wbIsTech(t) {
    const s = String(t || '').toLowerCase().trim();
    if (!s) return false;
    if (WB_TECH_HINTS.indexOf(s) >= 0) return true;
    if (WB_TECH_HINTS.some(h => h.indexOf(' ') >= 0 && s.indexOf(h) >= 0)) return true;
    const words = s.split(/[^a-z0-9+]+/).filter(Boolean);
    return words.some(w => WB_TECH_HINTS.indexOf(w) >= 0);
  }

  /** 初步分类：AI 答案里标了（普通词）就是普通词；缩写/符号单独一类；其余按专业术语处理 */
  function classifyTerm(term, answer) {
    const t = wbCleanTerm(term);
    const a = String(answer || '');
    if (wbIsAbbr(t)) return 'abbr';
    if (a && /（普通词）|\(普通词\)/.test(a)) return wbIsPhrase(t) ? 'phrase' : 'word';
    if (wbIsTech(t)) return 'term';
    if (!a && wbIsPhrase(t)) return 'phrase';
    return 'term';
  }

  function wbExtractZh(text) {
    const m = /(?:译名|释义)[：:]\s*([^\n｜|]+)/.exec(String(text || ''));
    if (!m) return '';
    return m[1].replace(/[（(]普通词[）)]/g, '').replace(/[。；;].*$/, '').trim().slice(0, 40);
  }

  function wbSectionSource(sid) {
    for (const ch of (S.chapters || [])) {
      if ((ch.sections || []).some(x => x.id === sid)) return '第' + ch.num + '章';
    }
    return '';
  }

  function wbAdd(entry) {
    const en = wbCleanTerm((entry && entry.en) || '');
    if (!en) return null;
    if (!Array.isArray(S.glossary)) S.glossary = [];
    const zh = String(entry.zh || '').trim();
    const note = String(entry.note || '').trim();
    const src = String(entry.src || '').trim();
    const cat = entry.cat || classifyTerm(en, note);
    const key = en.toLowerCase();
    const cur = S.glossary.find(g => String(g.en || '').toLowerCase() === key);
    if (cur) {
      if (!cur.zh && zh) cur.zh = zh;
      if (!cur.note && note) cur.note = note;
      if (!cur.src && src) cur.src = src;
      if (!cur.cat) cur.cat = cat;
      cur.updatedAt = nowStr();
      return { item: cur, created: false };
    }
    const item = { id: uid(), en, zh, note, cat, src,
      srs: { due: wbToday(), interval: 0, ease: 2.5, reps: 0, lapses: 0 },
      source: entry.source || 'lookup', createdAt: nowStr() };
    S.glossary.push(item);
    return { item, created: true };
  }


  /* ---------------------------------------------------------- 单词复习（遗忘曲线 + 四选一） */
  function wbYmd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function wbToday() { return wbYmd(new Date()); }
  function wbAddDays(ymd, n) {
    const d = new Date(String(ymd) + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return wbYmd(d);
  }
  function wbShuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function wbEnsureSrs(g) {
    if (!g.srs) g.srs = { due: wbToday(), interval: 0, ease: 2.5, reps: 0, lapses: 0 };
    else {
      if (!g.srs.due) g.srs.due = wbToday();
      if (typeof g.srs.interval !== 'number') g.srs.interval = 0;
      if (!g.srs.ease) g.srs.ease = 2.5;
      if (!g.srs.reps) g.srs.reps = 0;
      if (!g.srs.lapses) g.srs.lapses = 0;
    }
  }
  function wbEntryCat(g) { return WB_CAT_NAMES[g.cat] ? g.cat : 'term'; }
  function wbEntryChapter(g) {
    const m = /第\s*(\d+)\s*章/.exec(g.src || '');
    return m ? ('第' + m[1] + '章') : (g.src || '未标注');
  }
  function wbNoteShort(g) {
    return String(g.note || '').replace(/\s+/g, ' ').trim().slice(0, 110);
  }
  function wbOptionText(g) {
    return wbNoteShort(g).replace(/^(译名|释义)[：:]\s*/, '')
      .replace(/[（(]普通词[）)]/g, '').replace(/\s{2,}/g, ' ').trim();
  }
  function wbReviewDaysGet() {
    const d = store.get('reviewDays', []);
    return Array.isArray(d) ? d : [];
  }
  function wbMarkReviewDay() {
    const d = wbReviewDaysGet();
    const t = wbToday();
    if (d.indexOf(t) < 0) { d.push(t); store.set('reviewDays', d.slice(-400)); }
  }
  function wbStreak() {
    const set = new Set(wbReviewDaysGet());
    let n = 0;
    const d = new Date();
    for (;;) {
      const k = wbYmd(d);
      if (!set.has(k)) break;
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }
  function wbLevenshtein(a, b) {
    a = String(a || ''); b = String(b || '');
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[m][n];
  }
  function revState() {
    if (!S.rev) {
      S.rev = { phase: 'setup', cfg: { cat: 'all', chapter: 'all', mode: 'due', quizType: 'en2zh', limit: 20 },
        queue: [], idx: 0, answered: false, sel: -1, correct: 0, wrong: [], input: '',
        rated: null, chosen: '', spellDist: 0, lastOk: null };
    }
    if (!S.rev.cfg) S.rev.cfg = {};
    if (!S.rev.cfg.quizType) S.rev.cfg.quizType = 'en2zh';
    return S.rev;
  }
  function revFiltered(cfg) {
    const today = wbToday();
    return (S.glossary || []).filter(g => {
      if (!g.en || !wbNoteShort(g)) return false;
      if (cfg.cat !== 'all' && wbEntryCat(g) !== cfg.cat) return false;
      if (cfg.chapter !== 'all' && wbEntryChapter(g) !== cfg.chapter) return false;
      if (cfg.mode === 'due') {
        if (!g.srs) return true;
        return String(g.srs.due || '') <= today;
      }
      if (cfg.mode === 'weak') {
        const s = g.srs;
        return !s || s.reps === 0 || s.lapses > 0 || s.lastWrong;
      }
      return true;
    });
  }
  /** rating: 'again' 忘记 / 'hard' 模糊 / 'good' 记得 */
  function wbSchedule(g, rating) {
    wbEnsureSrs(g);
    const s = g.srs;
    if (rating === 'again') {
      s.lapses = (s.lapses || 0) + 1;
      s.reps = 0;
      s.interval = 1;
      s.ease = Math.max(1.3, (s.ease || 2.5) - 0.2);
      s.lastWrong = wbToday();
    } else if (rating === 'hard') {
      s.reps = (s.reps || 0) + 1;
      s.interval = (s.interval || 0) < 1 ? 1 : Math.max(1, Math.round((s.interval || 1) * 1.2));
      s.ease = Math.max(1.3, (s.ease || 2.5) - 0.05);
    } else {
      s.reps = (s.reps || 0) + 1;
      s.interval = s.reps <= 1 ? 1 : (s.reps === 2 ? 3 : Math.max(3, Math.round((s.interval || 1) * (s.ease || 2.5))));
      s.ease = Math.min(2.9, (s.ease || 2.5) + 0.1);
      if (s.lastWrong) delete s.lastWrong;
    }
    s.due = wbAddDays(wbToday(), s.interval || 1);
  }
  function wbPickDecoys(g, field, n) {
    const all = (S.glossary || []).filter(x => x.id !== g.id && wbNoteShort(x));
    const textOf = x => (field === 'term' ? String(x.en || '').trim() : wbOptionText(x));
    const target = textOf(g);
    const pool = all.map(x => {
      const t = textOf(x);
      let score = 0;
      if (wbEntryCat(x) !== wbEntryCat(g)) score += 100;
      if (wbEntryChapter(x) !== wbEntryChapter(g)) score += 20;
      score += Math.abs(t.length - target.length) / 25;
      return { t, score };
    }).filter(o => o.t && o.t !== target);
    const head = pool.slice().sort((a, b) => a.score - b.score).slice(0, Math.max(12, n * 4));
    const seen = new Set([target]);
    const out = [];
    wbShuffle(head).forEach(o => { if (!seen.has(o.t) && out.length < n) { seen.add(o.t); out.push(o.t); } });
    if (out.length < n) {
      wbShuffle(pool).forEach(o => { if (!seen.has(o.t) && out.length < n) { seen.add(o.t); out.push(o.t); } });
    }
    return out;
  }
  function wbSpellNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function revQueueFrom(list, cfg) {
    const R = revState();
    const qs = [];
    list.forEach(g => {
      const type = cfg.quizType || 'en2zh';
      if (type === 'spell') {
        qs.push({ entryId: g.id, type: 'spell',
          prompt: wbOptionText(g), term: g.en, note: wbOptionText(g),
          cat: wbEntryCat(g), src: g.src || '', answerText: String(g.en || '').trim() });
        return;
      }
      if (type === 'zh2en') {
        const correct = String(g.en || '').trim();
        const decoys = wbPickDecoys(g, 'term', 3);
        if (decoys.length < 3) return;
        const options = wbShuffle([correct].concat(decoys));
        qs.push({ entryId: g.id, type: 'choice', prompt: wbOptionText(g), term: g.en, note: wbOptionText(g),
          cat: wbEntryCat(g), src: g.src || '', options, answer: options.indexOf(correct), answerText: correct });
        return;
      }
      const correct = wbOptionText(g);
      const decoys = wbPickDecoys(g, 'note', 3);
      if (decoys.length < 3) return;
      const options = wbShuffle([correct].concat(decoys));
      qs.push({ entryId: g.id, type: 'choice', prompt: String(g.en || ''), term: g.en, note: correct,
        cat: wbEntryCat(g), src: g.src || '', options, answer: options.indexOf(correct), answerText: correct });
    });
    if (!qs.length) { toast('这个筛选下可用单词不足，无法出题'); return false; }
    R.queue = qs; R.idx = 0; R.answered = false; R.sel = -1; R.correct = 0; R.wrong = []; R.input = '';
    R.rated = null; R.chosen = ''; R.spellDist = 0; R.lastOk = null; R.phase = 'quiz';
    showView('review');
    return true;
  }
  function revBuildQueue() {
    const R = revState();
    const cfg = R.cfg || { cat: 'all', chapter: 'all', mode: 'due', quizType: 'en2zh', limit: 20 };
    const cands = revFiltered(cfg);
    if (!cands.length) { toast('这个筛选下没有可复习的单词'); return; }
    const limit = Math.max(1, parseInt(cfg.limit, 10) || 20);
    const wrongFirst = cands.filter(g => g.srs && g.srs.lastWrong);
    const rest = cands.filter(g => !(g.srs && g.srs.lastWrong));
    const picked = wbShuffle(wrongFirst).concat(wbShuffle(rest)).slice(0, limit);
    revQueueFrom(picked, cfg);
  }
  function revRetryWrong() {
    const R = revState();
    const ids = new Set((R.wrong || []).map(w => w.entryId));
    const list = (S.glossary || []).filter(g => ids.has(g.id) && wbNoteShort(g));
    if (!list.length) { toast('本轮没有错词'); return; }
    revQueueFrom(wbShuffle(list), R.cfg);
    toast('只练本轮错词：' + list.length + ' 张');
  }
  function revFinish(ok, chosen, dist) {
    const R = revState();
    const q = R.queue[R.idx];
    if (!q) return;
    R.answered = true;
    R.lastOk = !!ok;
    R.chosen = chosen || '';
    R.spellDist = Number(dist) || 0;
    R.rated = null;
    showView('review');
  }
  function revApplyRating(level) {
    const R = revState();
    const q = R.queue[R.idx];
    if (!q || !R.answered || R.rated) return;
    const g = (S.glossary || []).find(x => x.id === q.entryId);
    if (g) { wbSchedule(g, level); saveGlossary(); updateCounts(); }
    R.rated = level;
    if (R.lastOk) R.correct++;
    else R.wrong.push({ entryId: q.entryId, term: q.term, type: q.type, correct: q.answerText,
      chosen: R.chosen, src: q.src || '' });
    wbMarkReviewDay();
  }
  function revRate(level) {
    const R = revState();
    if (!R.answered || R.rated) return;
    revApplyRating(level);
    showView('review');
  }
  function revAnswer(i) {
    const R = revState();
    const q = R.queue[R.idx];
    if (!q || q.type !== 'choice' || R.answered || i < 0 || i >= q.options.length) return;
    R.sel = i;
    revFinish(i === q.answer, q.options[i], 0);
  }
  function revSubmitSpell() {
    const R = revState();
    const q = R.queue[R.idx];
    if (!q || q.type !== 'spell' || R.answered) return;
    const input = (($('#revInput') || {}).value) || '';
    if (!input.trim()) { toast('先输入答案'); return; }
    R.input = input;
    const ok = wbSpellNorm(input) === wbSpellNorm(q.answerText);
    const dist = wbLevenshtein(wbSpellNorm(input), wbSpellNorm(q.answerText));
    revFinish(ok, input.trim(), dist);
  }
  function revNext() {
    const R = revState();
    if (!R.answered) return;
    if (!R.rated) revApplyRating(R.lastOk ? 'good' : 'again');
    R.idx++;
    if (R.idx >= R.queue.length) R.phase = 'done';
    else { R.answered = false; R.sel = -1; R.input = ''; R.rated = null; R.chosen = ''; R.spellDist = 0; }
    showView('review');
  }

  /** 查词结果自动同步到单词本（已有则补全字段，不重复） */
  function syncLookupWord(term, text, opts) {
    const r = wbAdd({
      en: term,
      zh: wbExtractZh(text),
      note: compactMeaning(text, term),
      cat: classifyTerm(term, text),
      src: (S.chapter ? ('第' + S.chapter.num + '章') : ''),
      source: 'lookup'
    });
    if (!r) return;
    saveGlossary(); updateCounts();
    if (r.created && !(opts && opts.silent)) toast('已自动加入单词本 · ' + wbCatName(r.item.cat), 1600);
  }

  /** 兼容旧数据：补 id / 分类，按单词去重 */
  function normalizeGlossary() {
    if (!Array.isArray(S.glossary)) S.glossary = [];
    let changed = false;
    const out = [];
    S.glossary.forEach(g => {
      if (!g || !g.en) { changed = true; return; }
      const en = wbCleanTerm(g.en);
      if (!en) { changed = true; return; }
      const key = en.toLowerCase();
      const cat = g.cat || classifyTerm(en, g.note || '');
      if (!g.cat) changed = true;
      if (!g.id) changed = true;
      const cur = out.find(x => String(x.en || '').toLowerCase() === key);
      if (cur) {
        changed = true;
        if (!cur.zh && g.zh) cur.zh = g.zh;
        if (!cur.note && g.note) cur.note = g.note;
        if (!cur.src && g.src) cur.src = g.src;
        return;
      }
      const item = Object.assign({}, g, { en, cat, id: g.id || uid(), source: g.source || 'manual' });
      if (!item.srs) { item.srs = { due: wbToday(), interval: 0, ease: 2.5, reps: 0, lapses: 0 }; changed = true; }
      out.push(item);
    });
    S.glossary = out;
    if (changed) { saveGlossary(); updateCounts(); }
    return changed;
  }

  /** 历史查词迁移：把以前查词产生的高亮标记（term:true）同步到单词本，只跑一次 */
  function migrateLookupHistory(force) {
    if (!force && wbFlagGet()) return 0;
    let n = 0;
    Object.keys(S.highlights || {}).forEach(sid => {
      (S.highlights[sid] || []).forEach(h => {
        if (!h || !h.term || !h.text) return;
        const en = String(h.text).trim();
        if (!en) return;
        const note = String(h.meaning || '');
        const r = wbAdd({ en, zh: '', note, cat: classifyTerm(en, note), src: wbSectionSource(sid), source: 'lookup' });
        if (r && r.created) n++;
      });
    });
    wbFlagSet();
    if (n) { saveGlossary(); updateCounts(); toast('已把 ' + n + ' 个历史查词同步到单词本', 2800); }
    return n;
  }

  function countLookupHistory() {
    const seen = new Set();
    Object.keys(S.highlights || {}).forEach(sid => {
      (S.highlights[sid] || []).forEach(h => {
        if (h && h.term && h.text) seen.add(wbCleanTerm(h.text).toLowerCase());
      });
    });
    return seen.size;
  }

  /** 重新按当前规则自动分类（会覆盖手动修改，用户主动点击/升级时执行） */
  function reclassifyWordbook() {
    let n = 0;
    (S.glossary || []).forEach(g => {
      if (!g || !g.en) return;
      const cat = classifyTerm(g.en, g.note || '');
      if (g.cat !== cat) { g.cat = cat; n++; }
    });
    if (n) { saveGlossary(); updateCounts(); }
    return n;
  }

  /** v2：修复旧迁移没跑/没保存导致单词本缺词，并重新分类 */
  function ensureWordbookV2() {
    if (wbV2Get()) return;
    const hist = countLookupHistory();
    if (hist > (S.glossary || []).length + 5) migrateLookupHistory(true);
    const n = reclassifyWordbook();
    wbV2Set();
    if (n) toast('已重新分类 ' + n + ' 条单词', 2200);
  }

  function saveMistakes() { store.set('mistakes', S.mistakes); scheduleAutoBackup(); }
  function savePlan() { store.set('plan', S.plan); scheduleAutoBackup(); }
  function savePlanCfg() { store.set('planCfg', S.planCfg); scheduleAutoBackup(); }

  function archiveSection(sid) { return (S.archive && S.archive[sid]) || null; }

  function saveArchive(patch) {
    if (!S.section) return;
    const sid = S.section.id;
    const a = S.archive[sid] || (S.archive[sid] = {});
    Object.assign(a, patch);
    a.updatedAt = nowStr();
    let json = JSON.stringify(S.archive);
    if (json.length > ARCH_MAX) {
      const ids = Object.keys(S.archive)
        .sort((x, y) => String(S.archive[x].updatedAt || '').localeCompare(String(S.archive[y].updatedAt || '')));
      while (json.length > ARCH_MAX && ids.length > 1) {
        const drop = ids.shift();
        if (drop !== sid) delete S.archive[drop];
        json = JSON.stringify(S.archive);
      }
    }
    try { store.set('archive', S.archive); scheduleAutoBackup(); }
    catch (e) { toast('本地存储空间不足，这一节的最新内容没能保存'); }
  }

  function archiveTabs(sid) {
    const a = archiveSection(sid) || {};
    const tabs = [];
    if (a.pre || a.preAnswers) tabs.push('pre');
    if (a.close || a.formula || a.cards) tabs.push('close');
    if (a.practiceQ) tabs.push('practice');
    if (a.feynmanQ || a.feynmanDiag) tabs.push('feynman');
    if (a.pack) tabs.push('pack');
    return tabs;
  }

  function findChapter(cid) {
    return S.chapters.find(c => c.id === cid) || null;
  }
  function findSection(sid) {
    if (!sid) return null;
    for (const ch of S.chapters) {
      const sec = ch.sections.find(s => s.id === sid);
      if (sec) return { chapter: ch, section: sec };
      // 每章末尾的习题（Problems）当作一个特殊小节
      if (ch.probsPage && sid === ch.id + '-problems') {
        return {
          chapter: ch,
          section: {
            id: sid, num: '习题', title: 'Problems / 习题',
            page: ch.probsPage, bookPage: ch.probsBookPage,
            isProblems: true, chapterId: ch.id
          }
        };
      }
    }
    return null;
  }
  function targetChapters() {
    return S.chapters.filter(c => c.num >= 1 && c.num <= CHAPTER_TARGET);
  }
  function learnedChapters() {
    return S.chapters.filter(c => {
      const st = chapterStats(c);
      return st.pct > 0.02;
    });
  }
  function learnedChaptersLabel() {
    const l = learnedChapters();
    if (!l.length) return '暂无（先去学一节吧）';
    return l.map(c => '第' + c.num + '章').join('、');
  }

  function ctxBase() {
    return {
      chapterTitle: S.chapter ? ('第 ' + S.chapter.num + ' 章 ' + S.chapter.title) : '',
      sectionTitle: S.section ? (S.section.num + ' ' + S.section.title) : '',
      num: S.chapter ? S.chapter.num : '',
      title: S.chapter ? S.chapter.title : ''
    };
  }


  // 读前预习需要覆盖整节。旧版硬编码 slice(0,9000)，长节只能看到开头；
  // 当前书最长约 5 万字符，直接完整送入（DeepSeek 上下文足够）。
  // 如果未来遇到更长的节，按整节均匀抽样，保证开头/中段/结尾都有覆盖。
  const PRE_TEXT_MAX = 60000;
  function sectionTextForPre(text) {
    text = text || '';
    if (text.length <= PRE_TEXT_MAX) return text;
    const parts = 12;
    const per = Math.floor(PRE_TEXT_MAX / parts);
    const step = text.length / parts;
    const chunks = [];
    for (let i = 0; i < parts; i++) {
      const start = Math.floor(i * step);
      const end = Math.min(text.length, Math.floor((i + 1) * step), start + per);
      chunks.push(text.slice(start, end));
    }
    return chunks.join('\n\n[…]（长节已按全文均匀采样）\n\n');
  }

  async function getSectionText(sid) {
    if (!sid) return '';
    if (S.sectionTexts[sid] != null) return S.sectionTexts[sid];
    if (!S.sectionPromises[sid]) {
      S.sectionPromises[sid] = API.section(sid).then(r => {
        S.sectionData[sid] = r;
        S.sectionTexts[sid] = r.text || '';
        return S.sectionTexts[sid];
      }).catch(e => {
        S.sectionTexts[sid] = '';
        return '';
      });
    }
    return S.sectionPromises[sid];
  }

  async function getSectionData(sid) {
    await getSectionText(sid);
    return S.sectionData[sid] || null;
  }

  async function getChapterContext(chid, max) {
    try {
      const r = await API.chapter(chid, max || 24000);
      return r.text || '';
    } catch (e) { return ''; }
  }

  // 同时拿到"全文长度"，便于提示是否被截断
  async function getChapterContextInfo(chid, max) {
    try {
      const r = await API.chapter(chid, max || 24000);
      return { text: r.text || '', chars: r.chars || 0, fullChars: r.full_chars || (r.text || '').length };
    } catch (e) {
      return { text: '', chars: 0, fullChars: 0 };
    }
  }

  // 单次请求最多送入的原文长度（约 1.5 万 token，DeepSeek 64k 上下文足够）
  const PACK_INPUT_CAP = 60000;

  // 习题页的费曼：整章正文 + 本章习题原文
  async function probFeynmanContext() {
    const chText = S.chapter ? await getChapterContext(S.chapter.id, 40000) : '';
    let probText = '';
    if (S.chapter && S.chapter.probsPage) {
      probText = (await getSectionText(S.chapter.id + '-problems')).slice(0, 15000);
    }
    return (chText + '\n\n【本章习题】\n' + probText).slice(0, 46000);
  }

  /* ---------------------------------------------------------- book */
  async function loadBook() {
    S.book = await API.book();
    S.chapters = [];
    (S.book.parts || []).forEach(part => {
      (part.chapters || []).forEach(ch => {
        S.chapters.push(Object.assign({ partTitle: part.title }, ch));
      });
    });
  }

  /* ---------------------------------------------------------- TOC */
  function sectionStatus(sid) {
    const p = S.progress[sid] || {};
    if (p.practice) return 'done';
    if (p.close) return 'close';
    if (p.pre) return 'pre';
    return 'none';
  }

  function saveExpanded() { store.set('expanded', S.expanded); }

  function isChapterDone(ch) {
    if (S.done && S.done[ch.id]) return true;
    return chapterStats(ch).pct >= 0.8;
  }

  function renderToc() {
    const nav = $('#toc');
    if (!nav) return;
    const parts = S.book.parts || [];
    let h = '';
    parts.forEach(part => {
      if (!part.chapters.length) return;
      const isFront = part.id === 'front';
      const partAllDone = part.chapters.every(ch => isChapterDone(ch));
      if (!isFront) {
        h += '<div class="toc-part"><span class="toc-part-title">' + esc(part.title) + '</span>' +
          '<button class="toc-done part-done' + (partAllDone ? ' on' : '') + '" data-act="toggle-part-done" data-id="' + part.id + '" ' +
          'title="把整个 ' + esc(part.title) + ' 标记为已学完 / 取消">' + (partAllDone ? '✓' : '○') + '</button></div>';
      }
      part.chapters.forEach(ch => {
        const st = chapterStats(ch);
        const active = S.chapter && S.chapter.id === ch.id;
        const done = isChapterDone(ch);
        const optional = ch.num > CHAPTER_TARGET;
        const open = !!S.expanded[ch.id];
        h += '<div class="toc-partbox">';
        h += '<div class="toc-row">' +
          '<button class="toc-chev' + (open ? ' open' : '') + '" data-act="toggle-chapter" data-id="' + ch.id + '" title="展开/收起本节小节">' +
          (open ? '▾' : '▸') + '</button>' +
          '<button class="toc-ch' + (active ? ' active' : '') + (done ? ' done' : '') + (optional ? ' optional' : '') +
          '" data-act="open-chapter" data-id="' + ch.id + '" title="' + esc(ch.title) + '">' +
          '<span class="toc-num">' + ch.num + '</span><span class="toc-title">' + esc(ch.title) + '</span>' +
          (st.total ? '<span class="toc-cnt">' + st.done + '/' + st.total + '</span>' : '') +
          '</button>' +
          '<button class="toc-done' + (done ? ' on' : '') + '" data-act="toggle-ch-done" data-id="' + ch.id + '" ' +
          'title="标记 / 取消「本章已学完」">' + (done ? '✓' : '○') + '</button>' +
          '</div>';
        if (open) {
          h += '<div class="toc-secs open">';
          ch.sections.forEach(sec => {
            const stt = sectionStatus(sec.id);
            h += '<button class="toc-sec' + (S.section && S.section.id === sec.id ? ' active' : '') + '" data-act="open-section" data-id="' + sec.id + '" title="' + esc(sec.num + ' ' + sec.title) + '">' +
              '<span class="sec-dot ' + stt + '"></span><span class="toc-sec-name">' + esc(sec.num + ' ' + sec.title) + '</span></button>';
          });
          if (ch.probsPage) {
            const pid = ch.id + '-problems';
            const pa = (S.archive && S.archive[pid]) || null;
            const pst = pa && ARCH_KEYS.some(k => pa[k]) ? 'pre' : 'none';
            h += '<button class="toc-sec toc-prob' + (S.section && S.section.id === pid ? ' active' : '') + '" data-act="open-section" data-id="' + pid + '" title="本章习题 Problems（可看原文 / 提取原文 / 习题解答 / 章节总结）">' +
              '<span class="sec-dot ' + pst + '"></span><span class="toc-sec-name">📝 习题 Problems</span></button>';
          }
          h += '</div>';
        }
        h += '</div>';
      });
    });
    nav.innerHTML = h;
    updateProgressBox();
  }

  function chapterStats(ch) {
    const total = ch.sections.length || 0;
    let score = 0, done = 0;
    ch.sections.forEach(sec => {
      const p = S.progress[sec.id] || {};
      const s = (p.pre ? 1 : 0) + (p.close ? 1 : 0) + (p.practice ? 1 : 0);
      score += s / 3;
      if (s > 0) done++;
    });
    return { total, done, pct: total ? score / total : 0 };
  }

  function updateProgressBox() {
    const chs = targetChapters();
    let stageTotal = 0, scoreDone = 0, chDone = 0, started = 0;
    chs.forEach(ch => {
      const st = chapterStats(ch);
      stageTotal += st.total;
      scoreDone += st.pct * st.total;
      if (st.pct > 0.01 || (S.done && S.done[ch.id])) started++;
      if (isChapterDone(ch)) chDone++;
    });
    const pct = stageTotal ? scoreDone / stageTotal : 0;
    const fill = $('#pbFill'), txt = $('#pbText'), sub = $('#pbSub');
    if (fill) fill.style.width = Math.round(pct * 100) + '%';
    if (txt) txt.textContent = chDone + ' / ' + CHAPTER_TARGET + ' 章已学完 · 小节 ' + Math.round(pct * 100) + '%';
    if (sub) sub.textContent = '已开始 ' + started + ' / ' + CHAPTER_TARGET + ' 章 · 目标：Part I + Part II · 12 月 1 日前';
  }

  function markStage(stage) {
    if (!S.section) return;
    const id = S.section.id;
    const p = S.progress[id] || (S.progress[id] = {});
    p[stage] = 1;
    saveProgress();
    renderToc();
  }

  /* ---------------------------------------------------------- reader */
  function openChapter(cid, keepSection) {
    const ch = findChapter(cid);
    if (!ch) return;
    S.chapter = ch;
    if (!S.expanded[ch.id]) { S.expanded[ch.id] = true; saveExpanded(); }
    if (!keepSection || !S.section || !ch.sections.find(s => s.id === S.section.id)) {
      openSection(ch.sections.length ? ch.sections[0].id : null);
      return;
    }
    renderToc();
    renderReaderHead();
    renderWork();
  }

  function openSection(sid) {
    const found = findSection(sid);
    if (!found) return;
    hideTermPop();
    hideHlPop();
    const changed = !S.section || S.section.id !== sid;
    S.chapter = found.chapter;
    S.section = found.section;
    S.page = (S.pos && S.pos[sid]) || found.section.page || 1;
    if (found.section.isProblems) {
      if (['probSolve', 'probAll', 'probSummary', 'probFeynman'].indexOf(S.workTab) < 0) S.workTab = 'probSolve';
    } else if (['pre', 'close', 'practice', 'feynman', 'ask', 'pack'].indexOf(S.workTab) < 0) {
      S.workTab = 'pre';
    }
    if (changed && found.section.isProblems) S.prob = { qno: '', question: '' };
    if (changed) {
      const arch = (S.archive && S.archive[sid]) || null;
      S.outs = {};
      if (arch) {
        ARCH_KEYS.forEach(k => { if (arch[k]) S.outs[k] = arch[k]; });
      }
      S.practice = {
        q: arch ? (arch.practiceQ || '') : '',
        a: arch ? (arch.practiceA || '') : '',
        fb: arch ? (arch.practiceFB || '') : '',
        type: S.practice.type, n: S.practice.n, level: S.practice.level, useProbs: S.practice.useProbs
      };
      S.feynman = {
        topic: arch ? (arch.feynmanTopic || '') : '',
        text: arch ? (arch.feynmanText || '') : '',
        q: arch ? (arch.feynmanQ || '') : '',
        a: arch ? (arch.feynmanA || '') : '',
        diag: arch ? (arch.feynmanDiag || '') : ''
      };
      S.chat = (arch && arch.chat && arch.chat.display && arch.chat.display.length)
        ? { first: arch.chat.first || '', msgs: arch.chat.msgs || [], display: arch.chat.display }
        : { first: '', msgs: [], display: [] };
      S.qa = (arch && arch.qa && arch.qa.display && arch.qa.display.length)
        ? { first: arch.qa.first || '', msgs: arch.qa.msgs || [], display: arch.qa.display,
            useText: arch.qa.useText !== false, useChapter: !!arch.qa.useChapter }
        : { first: '', msgs: [], display: [], useText: true, useChapter: false };
      S.drafts = Object.assign({ close: '', formula: '', cards: '', ask: '' }, (arch && arch.drafts) || {});
      S.probSolves = (arch && Array.isArray(arch.probSolves)) ? arch.probSolves.slice() : [];
      if (arch) {
        const hasContent = ARCH_KEYS.some(k => arch[k]) || (arch.chat && arch.chat.display && arch.chat.display.length) || (arch.qa && arch.qa.display && arch.qa.display.length);
        if (hasContent) toast('已恢复本节上次生成的内容（' + (arch.updatedAt || '') + '）', 2200);
      }
    }
    if (S.expanded[found.chapter.id] === undefined) {
      S.expanded[found.chapter.id] = true;
      saveExpanded();
    }
    store.set('lastSection', sid);
    renderToc();
    renderReaderHead();
    renderPageImage();
    renderTextPane();
    renderWork();
  }

  function renderReaderHead() {
    const ch = S.chapter;
    const head = $('#rhChapter'), sel = $('#sectionSelect');
    if (head) head.textContent = ch ? ('第 ' + ch.num + ' 章 · ' + ch.title) : '选择章节';
    if (sel && ch) {
      const opts = ch.sections.map(s =>
        '<option value="' + s.id + '"' + (S.section && S.section.id === s.id ? ' selected' : '') + '>' +
        esc(s.num + ' ' + s.title) + '</option>');
      if (ch.probsPage) {
        const pid = ch.id + '-problems';
        opts.push('<option value="' + pid + '"' + (S.section && S.section.id === pid ? ' selected' : '') + '>习题 Problems</option>');
      }
      sel.innerHTML = opts.join('');
    }
    const pi = $('#pageInput');
    if (pi) pi.value = S.page;
    const hint = $('#rtHint');
    if (hint) {
      hint.textContent = (S.section && S.section.isProblems)
        ? '选中文字可 🖍高亮 / ⚡查词'
        : '选中文字可 🖍高亮 / ⚡查词 / 四栏精读';
    }
  }

  function spreadStep() {
    return S.ui.spread === 'double' ? 2 : 1;
  }

  function renderPageImage() {
    const wrap = $('#pageWrap');
    if (!wrap) return;
    const max = (S.book && S.book.pdfPages) || 1200;
    const single = S.ui.spread !== 'double';
    const pages = [S.page];
    if (!single && S.page + 1 <= max) pages.push(S.page + 1);
    wrap.classList.toggle('double', !single);
    wrap.innerHTML = pages.map(n =>
      '<div class="page-cell"><img class="page-img" alt="第 ' + n + ' 页" src="' + API.pageUrl(n, S.dpi) + '"></div>'
    ).join('');
    $$('.page-img', wrap).forEach(img => {
      img.addEventListener('error', () => {
        const pane = $('#pagePane');
        if (pane && !pane.querySelector('.page-error')) {
          pane.innerHTML = '<div class="page-error">教材页面加载失败。<br>请确认 <code>python -m pip install pymupdf</code> 已安装、' +
            'PDF 路径正确（<code>config.json</code>），然后重启 <code>server.py</code>。<br>' +
            '文字仍可在「提取原文」中阅读。</div>';
        }
      });
    });
    // 预加载下一页，翻页更顺
    const preload = new Image();
    preload.src = API.pageUrl(Math.min(max, S.page + pages.length), S.dpi);
    const pi = $('#pageInput');
    if (pi) pi.value = S.page;
  }

  let posTimer = null;
  function savePos() {
    clearTimeout(posTimer);
    posTimer = setTimeout(() => store.set('pos', S.pos), 400);
  }

  function setPage(n) {
    if (!S.book) return;
    const max = S.book.pdfPages || 1000;
    S.page = Math.max(1, Math.min(max, n));
    if (S.section) {
      S.pos[S.section.id] = S.page;
      savePos();
    }
    renderPageImage();
    if (S.readerTab === 'text') renderTextPane();
  }

  async function renderTextPane() {
    const pane = $('#textPane');
    if (!pane) return;
    if (!S.section) { pane.innerHTML = '<div class="text-loading">先在左侧目录选择一个小节</div>'; return; }
    const keepScroll = pane.scrollTop;
    pane.innerHTML = '<div class="text-loading">加载原文…</div>';
    const sid = S.section.id;
    await getSectionText(sid);
    if (!S.section || S.section.id !== sid) return;
    const data = S.sectionData[sid] || null;

    // ---- 新版：按 items 渲染（正文段落 + 内嵌图表/公式图片） ----
    if (data && data.items && data.paras) {
      S.currentParas = data.paras;
      const hls = resolveHighlights(sid, data.paras);
      if (!data.items.length) {
        pane.innerHTML = '<div class="text-loading">这一节没有提取到文字（可能是纯图页），请看「教材页面」。</div>';
        return;
      }
      let html = '';
      const isProbs = !!(S.section && S.section.isProblems);
      const imgScale = S.ui.imgScale || 0.5;
      let probOpen = false;
      const closeProb = () => {
        if (probOpen) { html += '</div>'; probOpen = false; }
      };
      data.items.forEach(it => {
        if (it.t === 'img') {
          const isTable = it.kind === 'table';
          const qs = 'page=' + it.page + '&x0=' + it.x0 + '&y0=' + it.y0 +
            '&x1=' + it.x1 + '&y1=' + it.y1;
          // 表格和普通图一致：原书点宽 × 2.36（170dpi）× 当前缩放（默认 50%）
          const wpx = it.w ? Math.round(it.w * (170 / 72) * imgScale) : null;
          const sizeAttr = wpx ? ' style="width:' + wpx + 'px" data-w="' + it.w + '"' : '';
          html += '<figure class="fig-block' + (isTable ? ' table-block' : '') + '"><a href="/api/band?' + qs + '&dpi=220" target="_blank" rel="noopener" title="点击查看大图">' +
            '<img loading="lazy"' + sizeAttr +
            ' src="/api/band?' + qs + '&dpi=170" alt="第 ' + it.page + ' 页的' + (isTable ? '表格' : '图表/公式') + '"></a>' +
            '<figcaption>第 ' + it.page + ' 页 · ' + (isTable ? '表格' : '图表 / 公式') + '</figcaption></figure>';
          return;
        }
        const i = it.i;
        const t = (data.paras[i] || '').trim();
        if (!t) return;
        if (/^problems?$/i.test(t)) {
          closeProb();
          html += '<div class="p-head">' + esc(t) + '</div>';
          return;
        }
        const isNewProb = isProbs && /^\d+\.\d+\s/.test(t);
        if (isNewProb) {
          closeProb();
          html += '<div class="prob-group">';
          probOpen = true;
        }
        if (!isNewProb &&
            /^\d+(\.\d+){0,2}\s+[A-Z]/.test(t) && t.length < 170 && (t.match(/[A-Za-z]/g) || []).length >= 10) {
          html += '<div class="p-head">' + esc(t) + '</div>';
          return;
        }
        if (t.length <= 220 && /^(Fig\.?|Figure|Table)\s*\d+(\.\d+)?\s+[A-Z]/.test(t)) {
          html += '<p class="para para-fig">' + esc(t) + '</p>';
          return;
        }
        const probCls = isProbs ? ' prob-item' : '';
        html += '<p class="para' + probCls + '" data-pi="' + i + '"><span class="para-text">' +
          renderTextWithHighlights(t, hls.filter(h => h.p === i)) +
          '</span>' + (isProbs ? '' : '<button class="p-read" data-act="para-read" data-i="' + i + '">精读</button>') + '</p>';
      });
      closeProb();
      pane.innerHTML = html;
      if (keepScroll) pane.scrollTop = keepScroll;
      return;
    }

    // ---- 兼容旧数据：纯文本 + 折叠碎片 ----
    const text = S.sectionTexts[sid] || '';
    const all = text.split(/\n{2,}/).filter(p => p.trim());
    S.currentParas = all;
    const hls = resolveHighlights(sid, all);
    if (!all.length) {
      pane.innerHTML = '<div class="text-loading">这一节没有提取到文字（可能是纯图页），请看「教材页面」。</div>';
      return;
    }
    let html = '';
    let frags = [];
    const flush = () => {
      if (!frags.length) return;
      html += '<details class="frag-box"><summary>PDF 图表 / 公式碎片 ' + frags.length +
        ' 行（点开查看；公式以「教材页面」为准）</summary>' +
        frags.map(t => '<p class="para-frag">' + esc(t) + '</p>').join('') + '</details>';
      frags = [];
    };
    all.forEach((raw, i) => {
      const t = raw.trim();
      if (t.length <= 220 && /^(Fig\.?|Figure|Table)\s*\d+(\.\d+)?\s+[A-Z]/.test(t)) {
        flush();
        html += '<p class="para para-fig">' + esc(t) + '</p>';
        return;
      }
      if (/^\d+(\.\d+){0,2}\s+[A-Z]/.test(t) && t.length < 90) {
        flush();
        html += '<div class="p-head">' + esc(t) + '</div>';
        return;
      }
      const letters = (t.match(/[A-Za-z]/g) || []).length;
      if (letters < 22) { frags.push(t); return; }
      flush();
      html += '<p class="para" data-pi="' + i + '"><span class="para-text">' +
        renderTextWithHighlights(t, hls.filter(h => h.p === i)) +
        '</span><button class="p-read" data-act="para-read" data-i="' + i + '">精读</button></p>';
    });
    flush();
    pane.innerHTML = html;
    if (keepScroll) pane.scrollTop = keepScroll;
  }

  /* ---------------------------------------------------------- 高亮 */
  function saveHighlights() { store.set('highlights', S.highlights); scheduleAutoBackup(); }

  /** 段落内容哈希：高亮按内容锚定，重建数据后也能找回原来的段落 */
  function textHash(t) {
    const s = String(t == null ? '' : t).trim();
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(36);
  }

  function nearestIdx(arr, target) {
    let best = arr[0], bd = Infinity;
    arr.forEach(i => { const d = Math.abs(i - target); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  /** 把存档里的高亮映射到当前段落：
   *  1) 有内容哈希且能在当前段落找到 → 自动修正段落序号；
   *  2) 哈希找不到时按高亮文本再找一次；
   *  3) 仍找不到的标记 orphan：不显示，但数据保留（下次可能恢复）。 */
  function resolveHighlights(sid, paras) {
    const list = (S.highlights && S.highlights[sid]) || [];
    if (!list.length || !paras) return [];
    const map = {};
    paras.forEach((t, i) => {
      const hh = textHash(t);
      (map[hh] || (map[hh] = [])).push(i);
    });
    let changed = false;
    const out = [];
    list.forEach(hl => {
      if (hl.h && map[hl.h] && (paras[hl.p] == null || textHash(paras[hl.p]) !== hl.h)) {
        hl.p = nearestIdx(map[hl.h], hl.p);
        changed = true;
      }
      let t = paras[hl.p];
      // 旧数据没有 h（或偏移对不上）：按高亮文本重新定位
      if (!hl.h || !t || t.slice(hl.start, hl.end) !== hl.text) {
        if (hl.text) {
          const cands = [];
          paras.forEach((x, i) => { if (x && x.indexOf(hl.text) >= 0) cands.push(i); });
          if (cands.length) {
            const p2 = nearestIdx(cands, hl.p);
            const pos = paras[p2].indexOf(hl.text);
            if (p2 !== hl.p || pos !== hl.start || hl.h !== textHash(paras[p2])) changed = true;
            hl.p = p2; hl.start = pos; hl.end = pos + hl.text.length;
            hl.h = textHash(paras[p2]);
            t = paras[p2];
          }
        }
      }
      if (!hl.h && t && t.slice(hl.start, hl.end) === hl.text) {
        hl.h = textHash(t);
        changed = true;
      }
      if (t == null || !hl.text || t.slice(hl.start, hl.end) !== hl.text) {
        hl.orphan = true;
        return;
      }
      delete hl.orphan;
      out.push(hl);
    });
    if (changed) saveHighlights();
    return out;
  }

  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderTextWithHighlights(text, hls) {
    if (!hls || !hls.length) return esc(text);
    const list = hls.slice().sort((a, b) => a.start - b.start);
    let html = '';
    let pos = 0;
    list.forEach(h => {
      const s = Math.max(0, Math.min(h.start, text.length));
      const e = Math.max(s, Math.min(h.end, text.length));
      if (s < pos || e <= s) return;
      html += esc(text.slice(pos, s));
      const cls = h.term ? 'hl hl-term' : ('hl c-' + (h.color || 'yellow'));
      html += '<mark class="' + cls + '" data-hid="' + escAttr(h.id) + '"' +
        (h.term && h.meaning ? ' data-meaning="' + escAttr(h.meaning) + '"' : '') +
        (!h.term && h.note ? ' data-note="' + escAttr(h.note) + '"' : '') + '>' +
        esc(text.slice(s, e)) + '</mark>';
      pos = e;
    });
    html += esc(text.slice(pos));
    return html;
  }

  function textOffsetIn(root, node, offset) {
    try {
      const r = document.createRange();
      r.setStart(root, 0);
      r.setEnd(node, offset);
      return r.toString().length;
    } catch (e) { return 0; }
  }

  /** 把当前选区换算成 [{p,start,end,text}]（仅限「提取原文」里的正文段落） */
  function captureSelectionRanges() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const anchor = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    if (!anchor || !anchor.closest('#textPane')) return [];
    const out = [];
    $$('#textPane .para').forEach(para => {
      const span = para.querySelector('.para-text');
      if (!span) return;
      if (!range.intersectsNode(span)) return;
      const total = span.textContent.length;
      let s = 0, e = total;
      if (span.contains(range.startContainer)) s = textOffsetIn(span, range.startContainer, range.startOffset);
      if (span.contains(range.endContainer)) e = textOffsetIn(span, range.endContainer, range.endOffset);
      s = Math.max(0, Math.min(s, total));
      e = Math.max(0, Math.min(e, total));
      if (e - s < 1) return;
      out.push({
        p: Number(para.dataset.pi),
        start: s,
        end: e,
        text: span.textContent.slice(s, e)
      });
    });
    return out;
  }

  function paraTextAt(p) {
    return ((S.currentParas && S.currentParas[p]) || '').trim();
  }

  /** 用已有高亮把一段区间切掉，返回剩余可用区间（用于"整段高亮时跳过已标记的词"） */
  function subtractRanges(r, existing) {
    let parts = [{ start: r.start, end: r.end }];
    existing.forEach(h => {
      const next = [];
      parts.forEach(p => {
        if (h.end <= p.start || h.start >= p.end) { next.push(p); return; }
        if (h.start > p.start) next.push({ start: p.start, end: h.start });
        if (h.end < p.end) next.push({ start: h.end, end: p.end });
      });
      parts = next;
    });
    return parts.filter(p => p.end - p.start > 0);
  }

  /** 添加手动荧光高亮：自动避开已有标记（词标记、其它荧光），只涂剩下的部分；
   *  若选区已被高亮覆盖，则更新这些高亮的颜色/注释。返回 {added, updated} */
  function addHighlights(ranges, opts) {
    if (!S.section || !ranges || !ranges.length) return { added: 0, updated: 0 };
    const sid = S.section.id;
    const list = S.highlights[sid] || (S.highlights[sid] = []);
    let n = 0;
    ranges.forEach(r => {
      const parts = subtractRanges(r, list.filter(h => h.p === r.p));
      parts.forEach(part => {
        list.push(Object.assign({
          id: uid(), p: r.p, start: part.start, end: part.end,
          text: paraTextAt(r.p).slice(part.start, part.end),
          h: textHash(paraTextAt(r.p)),
          color: 'yellow', ts: nowStr()
        }, opts || {}));
        n++;
      });
    });
    S.highlights[sid] = list;
    if (n) { saveHighlights(); renderTextPane(); return { added: n, updated: 0 }; }
    // 全被已有高亮覆盖：当成"更新颜色 / 注释"
    const opt = opts || {};
    let m = 0;
    ranges.forEach(r => {
      list.forEach(h => {
        if (h.term || h.p !== r.p) return;
        if (h.start < r.end && r.start < h.end) {
          if (opt.color) h.color = opt.color;
          if (opt.note !== undefined) h.note = opt.note;
          h.ts = nowStr();
          m++;
        }
      });
    });
    if (m) { saveHighlights(); renderTextPane(); }
    return { added: 0, updated: m };
  }

  /** 添加查词标记：如果落在已有荧光里，就把荧光切开，保留词标记 */
  function addTermHighlights(ranges, meaning) {
    if (!S.section || !ranges || !ranges.length) return 0;
    const sid = S.section.id;
    const list = S.highlights[sid] || [];
    let n = 0;
    ranges.forEach(r => {
      const rebuilt = [];
      list.forEach(h => {
        if (h.p !== r.p || h.end <= r.start || h.start >= r.end) { rebuilt.push(h); return; }
        if (h.term) { rebuilt.push(h); return; }
        if (h.start < r.start) {
          rebuilt.push(Object.assign({}, h, { id: uid(), end: r.start, text: paraTextAt(h.p).slice(h.start, r.start) }));
        }
        if (h.end > r.end) {
          rebuilt.push(Object.assign({}, h, { id: uid(), start: r.end, text: paraTextAt(h.p).slice(r.end, h.end) }));
        }
      });
      list.length = 0;
      list.push.apply(list, rebuilt);
      const dupTerm = list.some(h => h.term && h.p === r.p && h.start < r.end && r.start < h.end);
      if (!dupTerm) {
        list.push({
          id: uid(), p: r.p, start: r.start, end: r.end, text: r.text,
          h: textHash(paraTextAt(r.p)),
          term: true, meaning: meaning, ts: nowStr()
        });
        n++;
      }
    });
    S.highlights[sid] = list;
    if (n) { saveHighlights(); renderTextPane(); }
    return n;
  }

  function removeHighlight(hid) {
    if (!S.section) return;
    const sid = S.section.id;
    const arr = S.highlights[sid] || [];
    const idx = arr.findIndex(h => h.id === hid);
    if (idx < 0) return;
    arr.splice(idx, 1);
    if (!arr.length) delete S.highlights[sid];
    saveHighlights();
    hideHlTip();
    renderTextPane();
    toast('已取消高亮');
  }

  function compactMeaning(text, term) {
    const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
    let pick = lines.find(l => /^译名/.test(l)) || lines[0] || '';
    // 悬停提示里不放公式源码，能读就行
    pick = pick
      .replace(/\$/g, '')
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
      .replace(/\\[a-zA-Z]+\s*/g, '')
      .replace(/[{}]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return pick.slice(0, 120);
  }

  function showHlTip(el, x, y) {
    const tip = $('#hlTip');
    if (!tip) return;
    const meaning = el.getAttribute('data-meaning') || '';
    const note = el.getAttribute('data-note') || '';
    let text = meaning || note || '已高亮';
    if (text.length > 220) text = text.slice(0, 220) + '…';
    tip.innerHTML = esc(text) + '<span class="hl-tip-hint">点击取消高亮</span>';
    tip.classList.remove('hidden');
    const w = tip.offsetWidth || 260;
    const h = tip.offsetHeight || 60;
    tip.style.left = Math.min(Math.max(8, x + 12), window.innerWidth - w - 8) + 'px';
    tip.style.top = Math.min(Math.max(8, y + 16), window.innerHeight - h - 8) + 'px';
  }

  function hideHlTip() {
    const tip = $('#hlTip');
    if (tip) tip.classList.add('hidden');
  }

  /* ---------------------------------------------------------- 荧光笔弹层 */
  function hideHlPop() {
    const p = $('#hlPop');
    if (p) p.classList.add('hidden');
    S.hlDraft = null;
  }

  function positionHlPop() {
    const pop = $('#hlPop');
    if (!pop || pop.classList.contains('hidden')) return;
    const r = S.selRect || { left: 40, top: 120, bottom: 140 };
    const w = pop.offsetWidth || 360;
    const h = pop.offsetHeight || 220;
    const left = Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function openHlPop() {
    const ranges = (S.pendingRanges && S.pendingRanges.length) ? S.pendingRanges.slice() : captureSelectionRanges();
    if (!ranges.length) { toast('高亮只支持「提取原文」里的正文段落'); return; }
    const pop = $('#hlPop');
    if (!pop) return;
    const color = S.ui.hlColor || 'yellow';
    S.hlDraft = { ranges: ranges, color: color };
    pop.classList.remove('hidden');
    const note = $('#hlNote');
    if (note) note.value = '';
    $$('#hlPop .hp-color').forEach(b => b.classList.toggle('on', b.dataset.v === color));
    positionHlPop();
  }

  function setHlColor(v) {
    if (!S.hlDraft) return;
    S.hlDraft.color = v;
    S.ui.hlColor = v;
    saveUi();
    $$('#hlPop .hp-color').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  }

  async function hlAi(kind) {
    if (!S.hlDraft) return;
    const text = S.hlDraft.ranges.map(r => r.text).join('\n').slice(0, 6000);
    if (!text) return toast('没有选中的文字');
    const ta = $('#hlNote');
    const btns = $$('#hlPop .hp-ai .btn');
    btns.forEach(b => { b.disabled = true; });
    ta.value = '';
    ta.placeholder = kind === 'translate' ? '翻译中…' : '总结中…';
    const task = kind === 'translate' ? 'hlTranslate' : 'hlSummary';
    const maxTokens = kind === 'translate' ? 900 : 260;
    let out = '';
    try {
      if (API.isDemo()) {
        const t = await PROMPTS.demo(task, { text });
        await typeOut(t, d => { out += d; ta.value = out; });
      } else {
        const msgs = await PROMPTS.build(task, Object.assign({ text }, ctxBase()));
        await API.stream(msgs, { maxTokens: maxTokens, temperature: 0.3, onDelta: d => { out += d; ta.value = out; } });
      }
      ta.placeholder = '可选：写一句注释帮助记忆…';
      ta.focus();
    } catch (e) {
      ta.placeholder = '可选：写一句注释帮助记忆…';
      toast('生成失败：' + (e && e.message ? e.message : e));
    } finally {
      btns.forEach(b => { b.disabled = false; });
    }
  }

  function saveHlDraft() {
    if (!S.hlDraft) return;
    const note = (($('#hlNote') || {}).value || '').trim();
    const res = addHighlights(S.hlDraft.ranges, { color: S.hlDraft.color, note: note || undefined });
    hideHlPop();
    if (res.added) toast('已高亮 ' + res.added + ' 处，悬停可看注释');
    else if (res.updated) toast('已更新 ' + res.updated + ' 处高亮的颜色/注释');
    else toast('这段已经高亮过了');
  }

  function setReaderTab(tab) {
    S.readerTab = tab;
    $$('.rt-btn').forEach(b => b.classList.toggle('active', b.dataset.rt === tab));
    $('#pagePane').classList.toggle('hidden', tab !== 'page');
    $('#textPane').classList.toggle('hidden', tab !== 'text');
    if (tab === 'text') renderTextPane();
  }

  /* ---------------------------------------------------------- work tabs */
  function outBlock(key, placeholder) {
    const has = !!S.outs[key];
    return '<div class="out ' + (has ? '' : 'empty') + '" id="out-' + key + '">' +
      (has ? '' : esc(placeholder || '生成后显示在这里')) + '</div>' +
      '<div class="toolbar" id="tools-' + key + '"></div>';
  }

  function renderProbSolve() {
    let h = '<div class="card"><div class="card-title">习题解答 <span class="tag">选一道题 · 逐步推导</span></div>' +
      '<div class="hint">填题号（如 2.1、2.3）即可；如果题号不好识别，把题干粘贴到下面更稳。每道题的解答都会单独保存，生成新题不会覆盖旧题。</div>' +
      '<div class="toolbar" style="align-items:center;gap:8px;flex-wrap:wrap">' +
      '<input class="input" id="probNo" placeholder="题号，如 2.1" value="' + esc(S.prob.qno) + '" style="max-width:150px">' +
      '<button class="btn primary" data-act="run-prob-solve">生成这道题的解答</button>' +
      '<button class="btn" data-act="prob-first">用第一题</button></div>' +
      '<textarea class="textarea" id="probQ" placeholder="可选：粘贴题干（题号识别不到时更可靠）" style="min-height:72px;margin-top:8px">' + esc(S.prob.question) + '</textarea>' +
      '</div>' + outBlock('probSolve', '生成后显示：题意 → 已知/求解 → 逐步推导 → 答案 → 易错提醒');
    const list = (S.probSolves || []).slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    if (list.length) {
      h += '<div class="card mt12"><div class="card-title">已保存的解答 <span class="tag">' + list.length + ' 道题 · 分开保存</span></div>' +
        '<div class="tiny muted" style="margin-bottom:8px">同题号重新生成会更新这一题；删除只影响当前这一条。</div>' +
        list.map(s => '<details class="prob-sol"><summary><b>题 ' + esc(s.qno || '未编号') + '</b>' +
          ' <span class="tiny muted">' + esc(s.ts || '') + (s.question ? ' · 自定义题干' : '') + '</span></summary>' +
          '<div class="md prob-sol-body" data-sid="' + esc(s.id) + '"></div>' +
          '<div class="toolbar"><button class="btn small-btn ghost" data-act="prob-sol-del" data-id="' + esc(s.id) + '">删除这条解答</button></div>' +
          '</details>').join('') + '</div>';
    }
    return h;
  }

  function renderProbAll() {
    let h = '<div class="card"><div class="card-title">习题全解 <span class="tag">逐题思路 + 关键步骤 + 最终答案</span></div>' +
      '<div class="hint">按本章 Problems 顺序逐题给出：一句话思路、关键步骤、最终答案（不展开冗长代数；需要展开某题时用「习题解答」）。题多时输出较长，会自动续写。</div>' +
      '<div class="toolbar"><button class="btn primary" data-act="run-prob-all">生成全部习题解答</button></div></div>' +
      outBlock('probAll', '生成后显示逐题解答（按题号）');
    return h;
  }

  function renderProbSummary() {
    let h = '<div class="card"><div class="card-title">章节知识提纲 <span class="tag">复习用 · 按小节整理</span></div>' +
      '<div class="hint">用本章全部正文生成一份「知识点提纲」：本章主线 → 按小节列核心概念 / 关键公式 / 前提假设 / 易错考点 → 公式速查表 → 概念关系导图 → 6 条「我能…」复习自检清单，适合考前扫读。</div>' +
      '<div class="toolbar"><button class="btn primary" data-act="run-prob-summary">生成章节知识提纲</button></div></div>' +
      outBlock('chSummary', '生成后显示：主线 / 分小节知识点 / 公式速查 / 概念关系 / 自检清单');
    return h;
  }

  function renderProbFeynman() {
    const f = S.feynman;
    const step = f.diag ? 3 : (f.q ? 2 : 1);
    const defaultTopic = S.chapter ? ('第' + S.chapter.num + '章 主线与关键结论') : '';
    let h = '<div class="card"><div class="card-title">费曼法（整章 / 习题） <span class="tag">讲给一个刚学完本章的人听</span></div>' +
      '<div class="tiny muted" style="margin-bottom:8px">第 ' + step + ' / 3 步：' +
      ['① 写下你的讲解', '② 回答“学生”的追问', '③ 看诊断报告'][step - 1] + '</div>';
    if (step === 1) {
      h += '<div class="field"><label>要讲的主题</label><input class="input" id="fyTopic" value="' +
        esc(f.topic || defaultTopic) + '"></div>' +
        '<textarea class="textarea" id="fyText" style="min-height:170px" placeholder="不看书画一遍：本章解决什么问题？各小节怎么串起来？关键假设是什么？习题里怎么用？（也可以只挑一道题，讲它的解法思路）">' + esc(f.text) + '</textarea>' +
        '<div class="toolbar"><button class="btn primary" data-act="run-prob-feynman-q">开始（AI 扮演初学者提问）</button></div>' +
        '<div class="hint">会参考「整章正文 + 本章习题」来提问；讲解至少 40 字，不许用“显然”“大家都知道”这类词。</div></div>' +
        outBlock('feynmanQ', '“学生”的追问会显示在这里');
    } else if (step === 2) {
      h += outBlock('feynmanQ', '');
      h += '<div class="card"><div class="card-title">我的回答</div>' +
        '<textarea class="textarea" id="fyAnswer" style="min-height:150px" placeholder="逐个回答上面的问题；答不上来就写“不确定，我的猜测是……”">' + esc(f.a) + '</textarea>' +
        '<div class="toolbar"><button class="btn primary" data-act="run-prob-feynman-diag">提交，看诊断报告</button>' +
        '<button class="btn ghost" data-act="prob-feynman-reset">重新开始</button></div></div>' +
        outBlock('feynmanDiag', '');
    } else {
      h += outBlock('feynmanDiag', '');
      h += '<div class="toolbar"><button class="btn" data-act="prob-feynman-reset">再讲一遍（换主题/重写）</button></div>';
    }
    return h;
  }

  const WORK_TABS_NORMAL = [['pre', '① 预习'], ['close', '② 精读'], ['practice', '③ 练习'], ['feynman', '④ 费曼'], ['ask', '💬 自由问答'], ['pack', '⑤ 学习包']];
  const WORK_TABS_PROBS = [['probSolve', '① 习题解答'], ['probAll', '② 习题全解'], ['probSummary', '③ 章节提纲'], ['probFeynman', '④ 费曼']];

  function renderWork() {
    const body = $('#workBody');
    if (!body) return;
    const probs = !!(S.section && S.section.isProblems);
    const defs = probs ? WORK_TABS_PROBS : WORK_TABS_NORMAL;
    if (!defs.some(t => t[0] === S.workTab)) S.workTab = defs[0][0];
    const tabsEl = $('#workTabs');
    if (tabsEl) {
      tabsEl.innerHTML = defs.map(t => '<button class="wt-btn' + (S.workTab === t[0] ? ' active' : '') +
        '" data-wt="' + t[0] + '">' + t[1] + '</button>').join('');
    }
    const map = {
      pre: renderPre, close: renderClose, practice: renderPractice, feynman: renderFeynman, ask: renderFreeAsk, pack: renderPack,
      probSolve: renderProbSolve, probAll: renderProbAll, probSummary: renderProbSummary,
      probFeynman: renderProbFeynman
    };
    body.innerHTML = (map[S.workTab] || (probs ? renderProbSolve : renderPre))();
    if (S.workTab === 'ask') renderQaLog();
    restoreOuts();
  }

  function restoreOuts() {
    const extra = TOOL_EXTRA;
    Object.keys(S.outs).forEach(key => {
      const el = document.getElementById('out-' + key);
      if (!el) return;
      const text = S.outs[key];
      if (!text) return;
      el.classList.remove('empty');
      U.renderMarkdown(el, text);
      attachTools(key, text, extra[key]);
    });
    // 特殊：练习/费曼/学习包在各自渲染里已写好内容占位，这里统一处理
    const p = S.practice;
    if (p.q) { const el = document.getElementById('out-practiceQ'); if (el) U.renderMarkdown(el, p.q); }
    if (p.fb) { const el = document.getElementById('out-practiceFB'); if (el) U.renderMarkdown(el, p.fb); }
    const f = S.feynman;
    if (f.q) { const el = document.getElementById('out-feynmanQ'); if (el) U.renderMarkdown(el, f.q); }
    if (f.diag) { const el = document.getElementById('out-feynmanDiag'); if (el) U.renderMarkdown(el, f.diag); }
    if (S.quiz.fb) { const el = document.getElementById('quizFb'); if (el) U.renderMarkdown(el, S.quiz.fb); }
    // 习题页：已保存的逐题解答
    const sols = S.probSolves || [];
    $$('.prob-sol-body').forEach(el => {
      const sidx = el.getAttribute('data-sid');
      const s = sols.find(x => x.id === sidx);
      if (s) U.renderMarkdown(el, s.text || '');
    });
  }

  const TOOL_EXTRA = {
    cards: '<button class="btn small-btn" data-act="cards-import" data-key="cards">导入单词本</button>' +
      '<button class="btn small-btn" data-act="cards-csv" data-key="cards">下载 CSV</button>',
    pack: '<button class="btn small-btn" data-act="pack-export" data-key="pack">导出 Markdown</button>' +
      '<button class="btn small-btn" data-act="pack-print" data-key="pack">打印</button>',
    probSolve: '<button class="btn small-btn" data-act="save-note" data-key="probSolve">存为笔记</button>',
    probAll: '<button class="btn small-btn" data-act="save-note" data-key="probAll">存为笔记</button>',
    chSummary: '<button class="btn small-btn" data-act="save-note" data-key="chSummary">存为笔记</button>',
    practiceQ: '<button class="btn small-btn" data-act="scroll-answer">去作答 ↓</button>',
    practiceFB: '<button class="btn small-btn" data-act="save-mistake">存入错题本</button>',
    quiz: '<button class="btn small-btn" data-act="quiz-save-mistakes">存入错题本</button>',
    feynmanDiag: '<button class="btn small-btn" data-act="save-note" data-key="feynmanDiag">存为笔记</button>'
  };

  function attachTools(key, text, extra) {
    const tools = document.getElementById('tools-' + key);
    if (!tools) return;
    tools.innerHTML =
      '<button class="btn small-btn" data-act="copy-out" data-key="' + key + '">复制</button>' +
      '<button class="btn small-btn" data-act="save-note" data-key="' + key + '">存为笔记</button>' +
      (extra || '');
  }

  /* ---------------------------------------------------------- renderers */
  function learnedContext() {
    const items = [];
    const curCh = S.chapter ? S.chapter.num : Infinity;
    const curMinor = S.section ? parseFloat(String(S.section.num).split('.')[1] || '0') : 0;
    const curK = curCh * 1000 + (isNaN(curMinor) ? 0 : curMinor);
    S.chapters.forEach(ch => {
      (ch.sections || []).forEach(sec => {
        const p = S.progress[sec.id] || {};
        if (!(p.pre || p.close || p.practice)) return;
        if (S.section && S.section.id === sec.id) return;
        const minor = parseFloat(String(sec.num).split('.')[1] || '0');
        const k = ch.num * 1000 + (isNaN(minor) ? 0 : minor);
        if (k >= curK) return;   // 只联动“本节之前”学过的小节
        items.push({ k: k, label: '第' + ch.num + '章 ' + sec.num + ' ' + sec.title });
      });
    });
    items.sort((a, b) => a.k - b.k);
    const labels = items.slice(-12).map(x => x.label);
    return { labels, text: labels.length ? labels.join('；') : '暂无已学内容' };
  }

  function renderPre() {
    const sec = S.section;
    const hasQ = !!S.outs.pre;
    const lc = learnedContext();
    let h = '<div class="card">' +
      '<div class="card-title">读前预习 <span class="tag">假设你完全没学过 · 先猜后读</span></div>' +
      '<div class="tiny muted" style="margin-bottom:8px">当前：' + esc(sec ? (sec.num + ' ' + sec.title) : '未选择小节') + '</div>' +
      '<label class="check"><input type="checkbox" id="preUseText" checked> 附上本节英文原文（出题更贴合原文，消耗更多 token）</label>' +
      '<div class="toolbar"><button class="btn primary" data-act="run-pre">生成 5 个读前问题</button>' +
      (hasQ ? '<button class="btn" data-act="run-pre-answers">看问题解答</button>' : '') +
      '<button class="btn" data-act="reader-text">对照原文阅读</button></div>' +
      '<div class="hint">问题按「零基础」设计：每题都标了去原文哪里验证。先自己想 30 秒、读原文，再点「看问题解答」对答案。</div>' +
      '<div class="hint">联动依据：' + (lc.labels.length
        ? esc(lc.labels.slice(-6).join('；')) + (lc.labels.length > 6 ? ' 等' : '')
        : '暂无已学记录（本次只出本节新知识题）') + '</div>' +
      '</div>' + outBlock('pre', '生成后显示在这里');
    if (hasQ) {
      h += '<div class="card mt12"><div class="card-title">读前问题解答 <span class="tag">先自己答，再看</span></div>' +
        '<div class="tiny muted">解答会先给直觉，再把你的说法对上书中术语（英文 + 中文），并指出读原文时该看哪张图/哪个式子。</div>' +
        '<div class="toolbar"><button class="btn primary" data-act="run-pre-answers">生成 5 题解答</button></div></div>' +
        outBlock('preAnswers', '生成后显示逐题解答');
    }
    return h;
  }

  function renderQaLog() {
    const out = $('#qaLog');
    if (!out) return;
    out.innerHTML = (S.qa.display || []).map(m => {
      if (m.role === 'user') return '<div class="chat-q"><b>问：</b>' + esc(m.text) + '</div>';
      return '<div class="chat-assistant md live">' + md(m.text || '') + '</div>';
    }).join('') || '<div class="tiny muted">还没有对话。针对这一节想到什么，直接问；勾选上面的原文选项可以让回答更准确。</div>';
    U.renderMath(out);
  }

  function renderFreeAsk() {
    if (!S.qa) S.qa = { first: '', msgs: [], display: [], useText: true, useChapter: false };
    const useText = S.qa.useText !== false;
    const useChapter = !!S.qa.useChapter;
    let h = '<div class="card"><div class="card-title">自由问答 <span class="tag">就本节内容随时提问</span></div>' +
      '<div class="tiny muted" style="margin-bottom:8px">当前：' +
        esc(S.chapter ? ('第 ' + S.chapter.num + ' 章 / ') : '') + esc(S.section ? S.section.title : '') +
      '　·　问答按小节保存，切换小节后仍然保留</div>' +
      '<div class="row" style="gap:16px;flex-wrap:wrap;margin-bottom:8px">' +
      '<label class="check"><input type="checkbox" id="qaUseText"' + (useText ? ' checked' : '') + '> 附上本节原文（推荐，更准确）</label>' +
      '<label class="check"><input type="checkbox" id="qaUseChapter"' + (useChapter ? ' checked' : '') + '> 附上整章上下文（较长）</label></div>' +
      '<div id="qaLog" class="md" style="max-height:380px;overflow:auto;background:#fafbfc;border:1px solid var(--line);border-radius:8px;padding:10px"></div>' +
      '<textarea class="textarea" id="qaInput" style="min-height:80px;margin-top:8px" placeholder="例如：为什么这里假设 CCM？如果进入 DCM，这个公式还成立吗？"></textarea>' +
      '<div class="toolbar"><button class="btn primary" data-act="run-qa">提问</button>' +
      '<button class="btn ghost" data-act="clear-qa">清空对话</button>' +
      '<span class="tiny muted">按 Enter 换行；点「提问」发送</span></div></div>';
    return h;
  }

  function saveQaArchive() {
    if (!S.section || !S.qa) return;
    saveArchive({
      qa: {
        first: S.qa.first || '',
        msgs: S.qa.msgs || [],
        display: (S.qa.display || []).map(m => ({ role: m.role, text: m.text })),
        useText: S.qa.useText !== false,
        useChapter: !!S.qa.useChapter
      }
    });
  }

  async function runFreeAsk() {
    const ta = $('#qaInput');
    const q = ta ? ta.value.trim() : '';
    if (!q) { toast('先写一个问题'); return; }
    if (S.busy) { toast('正在生成，请稍候…'); return; }
    const useText = $('#qaUseText') ? $('#qaUseText').checked : S.qa.useText !== false;
    const useChapter = $('#qaUseChapter') ? $('#qaUseChapter').checked : !!S.qa.useChapter;
    S.qa.useText = useText;
    S.qa.useChapter = useChapter;
    S.busy = true;
    document.body.classList.add('generating');
    ta.value = '';
    S.qa.display.push({ role: 'user', text: q });
    renderQaLog();
    const out = $('#qaLog');
    if (!out) {
      S.busy = false;
      document.body.classList.remove('generating');
      return;
    }
    const bubble = document.createElement('div');
    bubble.className = 'chat-assistant md live';
    out.appendChild(bubble);
    S.qa.display.push({ role: 'assistant', text: '', el: bubble });
    const ac = new AbortController();
    S.abort = ac;
    let timer = null;
    try {
      const ctx = Object.assign({}, ctxBase(), { question: q, text: '', chapterText: '' });
      if (useText && S.section) ctx.text = (await getSectionText(S.section.id)).slice(0, 14000);
      if (useChapter && S.chapter) ctx.chapterText = (await getChapterContext(S.chapter.id, 30000)) || '';
      let messages;
      if (!S.qa.msgs.length) {
        const built = await PROMPTS.build('freeQa', ctx);
        S.qa.first = built[1].content;
        S.qa.msgs = [built[1]];
        messages = built;
      } else {
        const sys = await PROMPTS.raw('system');
        const history = S.qa.msgs.slice(-12);
        messages = [{ role: 'system', content: sys }].concat(history, [{ role: 'user', content: q }]);
        S.qa.msgs.push({ role: 'user', content: q });
      }
      let text = '';
      let lastLen = -1;
      timer = setInterval(() => {
        if (text.length !== lastLen) { lastLen = text.length; bubble.innerHTML = md(text); }
      }, 130);
      if (API.isDemo()) {
        const t = await PROMPTS.demo('freeQa', { question: q });
        await typeOut(t, d => { text += d; }, ac.signal);
      } else {
        await API.stream(messages, { signal: ac.signal, onDelta: d => { text += d; } });
      }
      clearInterval(timer);
      if (text.trim()) { bubble.innerHTML = md(text); renderMath(bubble); }
      else bubble.textContent = '（没有返回内容）';
      S.qa.msgs.push({ role: 'assistant', content: text });
      S.qa.display[S.qa.display.length - 1].text = text;
      saveQaArchive();
    } catch (err) {
      clearInterval(timer);
      bubble.innerHTML = '<div class="err-box">⚠️ ' + esc(err && err.message ? err.message : String(err)) + '</div>';
    } finally {
      S.busy = false;
      S.abort = null;
      document.body.classList.remove('generating');
      const body = $('#workBody');
      if (body) U.scrollToBottom(body);
    }
  }


  function renderClose() {
    const tabs = [['four', '逐句四栏'], ['formula', '公式拆解'], ['cards', '术语卡'], ['ask', '追问']];
    let h = '<div class="chips" style="margin-bottom:12px">' + tabs.map(t =>
      '<button class="chip' + (S.closeTab === t[0] ? ' on' : '') + '" data-act="close-tab" data-v="' + t[0] + '">' + t[1] + '</button>').join('') + '</div>';

    if (S.closeTab === 'four') {
      h += '<div class="card"><div class="card-title">四栏精读 <span class="tag">英文原句 → 直译 → 术语 → 论证作用</span></div>' +
        '<div class="hint" style="margin-bottom:6px">在左侧「提取原文」里选中一段文字，点浮动工具条的「四栏精读」会自动填入；也可以直接粘贴。</div>' +
        '<textarea class="textarea" id="closeInput" placeholder="粘贴要精读的英文段落">' + esc(S.drafts.close) + '</textarea>' +
        '<div class="toolbar"><button class="btn primary" data-act="run-close">生成四栏精读</button>' +
        '<button class="btn" data-act="fill-first-para">用本节首段</button></div></div>' + outBlock('close', '生成后显示四栏表格');
    } else if (S.closeTab === 'formula') {
      h += '<div class="card"><div class="card-title">公式拆解 <span class="tag">假设 → 符号 → 失效场景</span></div>' +
        '<textarea class="textarea" id="formulaInput" placeholder="粘贴公式或一段推导步骤，例如：V = DVg 或由伏秒平衡导出 M(D)">' + esc(S.drafts.formula) + '</textarea>' +
        '<div class="toolbar"><button class="btn primary" data-act="run-formula">拆解这一步</button></div></div>' + outBlock('formula', '生成后显示假设、符号与失效场景');
    } else if (S.closeTab === 'cards') {
      h += '<div class="card"><div class="card-title">术语卡 <span class="tag">可直接导入 Anki</span></div>' +
        '<div class="hint" style="margin-bottom:6px">快捷用法：在左侧「提取原文」里**选中一个词/短语**，点浮动条的「⚡ 查词」，立刻给出结合上下文的中文译名（不用等长输出）。选中整段才是生成完整术语卡。</div>' +
        '<textarea class="textarea" id="cardsInput" placeholder="粘贴一段原文，或只写主题，如：CCM 与 DCM 的边界">' + esc(S.drafts.cards) + '</textarea>' +
        '<div class="toolbar"><button class="btn primary" data-act="run-cards">生成术语卡</button></div></div>' + outBlock('cards', '生成后显示 CSV 与易混点');
    } else {
      h += '<div class="card"><div class="card-title">追问 <span class="tag">带本节原文上下文</span></div>' +
        '<div class="md" id="out-chat" style="max-height:340px;overflow:auto"></div>' +
        '<textarea class="textarea" id="askInput" style="min-height:70px;margin-top:8px" placeholder="就本节内容提问，例如：为什么 Buck 的 M 与负载无关？"></textarea>' +
        '<div class="toolbar"><button class="btn primary" data-act="run-ask">发送</button>' +
        '<button class="btn ghost" data-act="clear-chat">清空对话</button></div></div>';
      renderChatLog();
    }
    return h;
  }

  function renderPractice() {
    const p = S.practice;
    const types = ['概念', '计算', '设计', '混合'];
    const levels = ['基础', '标准', '挑战'];
    let h = '<div class="card"><div class="card-title">读后练习 <span class="tag">出题 → 作答 → 批改 → 错题本</span></div>';
    h += '<div class="field"><label>题型</label><div class="chips">' + types.map(t =>
      '<button class="chip' + (p.type === t ? ' on' : '') + '" data-act="p-type" data-v="' + t + '">' + t + '</button>').join('') + '</div></div>';
    h += '<div class="field"><label>难度</label><div class="chips">' + levels.map(l =>
      '<button class="chip' + (p.level === l ? ' on' : '') + '" data-act="p-level" data-v="' + l + '">' + l + '</button>').join('') + '</div></div>';
    h += '<div class="row"><div class="field" style="width:120px"><label>题量</label><select id="pN">' +
      [1, 2, 3, 5].map(n => '<option value="' + n + '"' + (p.n === n ? ' selected' : '') + '>' + n + ' 题</option>').join('') +
      '</select></div><label class="check" style="align-self:flex-end"><input type="checkbox" id="pProbs"' + (p.useProbs ? ' checked' : '') + '> 参考课后习题</label></div>';
    h += '<div class="toolbar"><button class="btn primary" data-act="run-practice">出题</button>';
    if (p.q) h += '<button class="btn ghost" data-act="practice-reset">换一组（清空）</button>';
    h += '</div></div>' + outBlock('practiceQ', '出题后显示题目');

    if (p.q) {
      h += '<div class="card"><div class="card-title">我的解答</div>' +
        '<textarea class="textarea" id="pAnswer" style="min-height:150px" placeholder="按题号作答，写清每一步；不会的写思路">' + esc(p.a) + '</textarea>' +
        '<div class="toolbar"><button class="btn primary" data-act="run-grade">提交批改</button></div></div>' +
        outBlock('practiceFB', '批改后显示结果');
    }
    return h;
  }

  function renderFeynman() {
    const f = S.feynman;
    const step = f.diag ? 3 : (f.q ? 2 : 1);
    let h = '<div class="card"><div class="card-title">费曼法 <span class="tag">讲给一个只学过电路分析的人听</span></div>' +
      '<div class="tiny muted" style="margin-bottom:8px">第 ' + step + ' / 3 步：' +
      ['① 写下你的讲解', '② 回答"大三学生"的追问', '③ 看诊断报告'][step - 1] + '</div>';

    if (step === 1) {
      h += '<div class="field"><label>要讲的主题</label><input class="input" id="fyTopic" value="' +
        esc(f.topic || (S.section ? S.section.num + ' ' + S.section.title : '')) + '"></div>' +
        '<textarea class="textarea" id="fyText" style="min-height:170px" placeholder="不看书画一遍：它解决什么问题？关键假设是什么？公式怎么来？用你自己的话讲">' + esc(f.text) + '</textarea>' +
        '<div class="toolbar"><button class="btn primary" data-act="run-feynman-q">开始（AI 扮演初学者提问）</button></div>' +
        '<div class="hint">费曼法要点：不许用"显然""大家都知道"这类词；每个术语第一次出现都要解释。</div></div>' +
        outBlock('feynmanQ', '"大三学生"的追问会显示在这里');
    } else if (step === 2) {
      h += outBlock('feynmanQ', '');
      h += '<div class="card"><div class="card-title">我的回答</div>' +
        '<textarea class="textarea" id="fyAnswer" style="min-height:150px" placeholder="逐个回答上面的问题">' + esc(f.a) + '</textarea>' +
        '<div class="toolbar"><button class="btn primary" data-act="run-feynman-diag">提交，看诊断报告</button>' +
        '<button class="btn ghost" data-act="feynman-reset">重新开始</button></div></div>' +
        outBlock('feynmanDiag', '');
    } else {
      h += outBlock('feynmanDiag', '');
      h += '<div class="toolbar"><button class="btn" data-act="feynman-reset">再讲一遍（换主题/重写）</button>' +
        '<button class="btn" data-act="save-note" data-key="feynmanDiag">存为笔记</button></div>';
    }
    return h;
  }

  function renderPack() {
    const p = S.pack;
    const selSet = new Set(p.parts || []);
    let h = '<div class="card"><div class="card-title">学习包 <span class="tag">自选内容 · 可导出 / 打印</span></div>';
    h += '<div class="field"><label>生成范围</label><div class="chips">' +
      '<button class="chip' + (p.scope === 'chapter' ? ' on' : '') + '" data-act="pack-scope" data-v="chapter">整章</button>' +
      '<button class="chip' + (p.scope === 'section' ? ' on' : '') + '" data-act="pack-scope" data-v="section">仅本节</button></div></div>';
    h += '<div class="field"><label>生成内容（可多选，不选的不会生成）</label><div class="pack-parts">' +
      PACK_PARTS.map(pp => '<label class="pack-part"><input type="checkbox" data-act="pack-part" data-v="' + pp.id + '"' +
        (selSet.has(pp.id) ? ' checked' : '') + '> ' + esc(pp.name) + '</label>').join('') +
      '</div>' +
      '<div class="tiny muted" style="margin-top:6px">勾得越少生成越快、越不容易触发输出上限。快捷：' +
      '<button class="link" data-act="pack-preset" data-v="all">全选</button> · ' +
      '<button class="link" data-act="pack-preset" data-v="none">清空</button> · ' +
      '<button class="link" data-act="pack-preset" data-v="summary">总结版</button>' +
      '（总结版 = 一句话 + 知识地图 + 知识点提纲 + 核心结论 + 易错 + 术语）</div></div>';
    const secChars = (S.section && S.section.chars) || 0;
    const chChars = (S.chapter && S.chapter.sections) ? S.chapter.sections.reduce((a, s) => a + (s.chars || 0), 0) : 0;
    const sizeTip = (n) => n > MAPREDUCE_THRESHOLD
      ? '（较长：会先分块提炼要点再合并，内容完整但慢一些）'
      : '（完整读取）';
    const sizeNote = (p.scope === 'chapter')
      ? (chChars ? '本章原文约 ' + chChars + ' 字符' + sizeTip(chChars) : '')
      : (secChars ? '本节原文约 ' + secChars + ' 字符' + sizeTip(secChars) : '');
    h += '<div class="tiny muted" style="margin-bottom:8px">' + (sizeNote ? sizeNote + ' · ' : '') +
      '生成后建议先自己过一遍，再用它复习。</div>';
    h += '<div class="toolbar"><button class="btn primary" data-act="run-pack">生成学习包</button>' +
      '<span class="tiny muted">' + esc(S.chapter ? '第' + S.chapter.num + '章 ' + S.chapter.title : '') + '</span></div></div>' +
      outBlock('pack', '生成后显示学习包（可导出 Markdown / 打印）');
    return h;
  }

  /* ---------------------------------------------------------- generation */
  function typeOut(text, onChunk, signal) {
    return new Promise((resolve, reject) => {
      let i = 0;
      const tick = () => {
        if (signal && signal.aborted) {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return;
        }
        const n = 8 + Math.floor(Math.random() * 18);
        const d = text.slice(i, i + n);
        i += n;
        if (d) onChunk(d);
        if (i >= text.length) { resolve(); return; }
        setTimeout(tick, 10);
      };
      tick();
    });
  }

  /** 流式请求 + 达到输出上限自动续写（map-reduce 的分块笔记用） */
  async function streamWithContinue(msgs0, signal) {
    let text = '';
    let msgs = msgs0;
    let round = 0;
    while (true) {
      const r = await API.stream(msgs, { signal, onDelta: d => { text += d; } });
      const fin = r && r.finish;
      if (fin !== 'length' || round >= 3) break;
      round++;
      msgs = msgs0.concat([
        { role: 'assistant', content: text },
        { role: 'user', content: '继续：紧接上面最后一个字符往下写，保持原有结构和编号；不要重复已输出的内容，不要重新开头。' }
      ]);
    }
    return text;
  }

  const MAPREDUCE_THRESHOLD = 24000;
  const CHUNK_CHARS = 24000;

  const OUTLINE_SPEC = [
    '## 一、本章主线（3–5 条）',
    '一条一句话，串起本章逻辑：要解决什么问题 → 用什么方法 → 得到什么结论 → 用在哪里。',
    '',
    '## 二、按小节的知识点',
    '按原文的小节顺序（如 2.1、2.2 …）逐节列出；每节格式固定：',
    '',
    '### <小节号> <小节标题>',
    '- **核心概念**：2–4 个，写成“名词：一句话解释”',
    '- **关键公式**：$...$ + 一句话含义（多条分列）',
    '- **前提 / 假设**：这些结论成立需要什么条件',
    '- **易错点 / 考点**：1–2 条',
    '',
    '只列原文里确实出现的小节，小节标题用原文标题。',
    '',
    '## 三、公式速查表',
    '| 公式 | 含义 | 适用条件 | 小节 |',
    '',
    '## 四、概念关系（文字版思维导图）',
    '缩进列表（最多 3 层），把本章概念串起来，每个节点后标小节号。',
    '',
    '## 五、复习自检清单（6 条）',
    '每条写成“我能……”，例如：“我能不看书画出 Buck / Boost / Buck-Boost 的 M(D)，并说出它的假设”。'
  ].join('\n');

  /** 长文本切成若干块（优先在段落边界切） */
  function splitTextChunks(text, size) {
    const s = String(text || '');
    if (s.length <= size) return [s];
    const chunks = [];
    let i = 0;
    while (i < s.length) {
      let end = Math.min(s.length, i + size);
      if (end < s.length) {
        let cut = s.lastIndexOf('\n\n', end);
        if (cut < i + size * 0.5) cut = s.lastIndexOf('. ', end);
        if (cut > i + size * 0.5) end = cut + 1;
      }
      chunks.push(s.slice(i, end));
      i = end;
    }
    return chunks;
  }

  /** 长文本「分块提炼要点 → 合并成最终结构」的准备步骤：返回最终请求的 messages */
  async function packNotesPrep(num, title, text, spec, status) {
    const chunks = splitTextChunks(text, CHUNK_CHARS);
    const notes = [];
    for (let i = 0; i < chunks.length; i++) {
      if (S.abort && S.abort.signal.aborted) {
        const e = new Error('aborted'); e.name = 'AbortError'; throw e;
      }
      if (status) status('正在分块阅读原文 ' + (i + 1) + ' / ' + chunks.length + '…');
      const msgs = await PROMPTS.build('packNotes', {
        num, title, part: i + 1, total: chunks.length, chunk: chunks[i]
      });
      notes.push(await streamWithContinue(msgs, S.abort.signal));
    }
    if (status) status('正在合并 ' + chunks.length + ' 段笔记，生成最终内容…');
    return PROMPTS.build('mergeNotes', {
      num, title, spec,
      notes: notes.map((n, i) => '### 片段 ' + (i + 1) + '\n' + n).join('\n\n')
    });
  }

  async function generate(opts) {
    const task = opts.task, ctx = opts.ctx || {};
    const outKey = opts.outKey;
    if (S.busy) { toast('正在生成，请稍候…'); return; }
    const target = document.getElementById(opts.targetId || ('out-' + outKey));
    if (!target) { toast('界面未就绪，请重试'); return; }

    S.busy = true;
    S.abort = new AbortController();
    document.body.classList.add('generating');
    const tools = document.getElementById('tools-' + outKey);
    if (tools) tools.innerHTML = '<button class="btn small-btn stop-btn" data-act="stop-gen">■ 停止</button>';
    target.classList.remove('empty');
    target.innerHTML = '<div class="md live"></div>';
    const live = target.firstChild;
    let text = '', lastLen = -1;
    const paint = (final) => {
      live.innerHTML = md(text) + (final ? '' : '<span class="cursor">▍</span>');
      if (final) renderMath(live);
    };
    paint(false);
    const timer = setInterval(() => {
      if (text.length !== lastLen) { lastLen = text.length; paint(false); }
    }, 130);

    try {
      if (API.isDemo()) {
        const t = await PROMPTS.demo(task, ctx);
        await typeOut(t, d => { text += d; }, S.abort.signal);
      } else {
        let msgs0;
        if (opts.prep) {
          const statusEl = document.createElement('div');
          statusEl.className = 'gen-note tiny muted';
          statusEl.textContent = '正在准备（长文本会先分块提炼要点）…';
          target.insertBefore(statusEl, live);
          try {
            msgs0 = await opts.prep(m => { statusEl.textContent = m; });
          } finally {
            statusEl.remove();
          }
          if (!msgs0) throw new Error('长文本分块准备失败');
        } else {
          msgs0 = await PROMPTS.build(task, ctx);
        }
        let msgs = msgs0;
        let round = 0;
        let noteEl = null;
        const MAX_ROUNDS = 3;
        while (true) {
          const r = await API.stream(msgs, { signal: S.abort.signal, onDelta: d => { text += d; } });
          const fin = r && r.finish;
          if (fin !== 'length') {
            if (noteEl && round > 0 && noteEl.textContent.indexOf('⚠️') < 0) {
              noteEl.textContent = '✅ 单次输出到上限后已自动续写 ' + round + ' 段，内容已完整';
            }
            break;
          }
          if (round >= MAX_ROUNDS) {
            if (noteEl) noteEl.textContent = '⚠️ 已自动续写 ' + round + ' 次仍达上限，内容可能仍不完整；可点「继续生成」或换个上下文更短的模型再试。';
            break;
          }
          round++;
          if (!noteEl) {
            noteEl = document.createElement('div');
            noteEl.className = 'gen-note tiny muted';
            target.insertBefore(noteEl, live);
          }
          noteEl.textContent = '⏳ 单次输出达到模型上限（max_tokens），正在自动续写第 ' + round + ' 段…';
          paint(false);
          msgs = msgs0.concat([
            { role: 'assistant', content: text },
            { role: 'user', content: '继续：紧接上面最后一个字符往下写，保持原有 Markdown 结构和编号；不要重复已输出的任何内容，不要重新开头，也不要输出“继续”之类的说明。' }
          ]);
        }
        if (noteEl) setTimeout(() => { try { noteEl.remove(); } catch (e) { /* ignore */ } }, 6000);
      }
      clearInterval(timer);
      if (!text.trim()) text = '（模型没有返回内容，请检查模型名 / Key / 余额）';
      paint(true);
      S.outs[outKey] = text;
      if (ARCH_KEYS.indexOf(outKey) >= 0) saveArchive({ [outKey]: text });
      attachTools(outKey, text, opts.extraTools || TOOL_EXTRA[outKey]);
      if (opts.after) opts.after(text);
    } catch (err) {
      clearInterval(timer);
      const aborted = err && err.name === 'AbortError';
      if (text.trim()) { paint(true); S.outs[outKey] = text; }
      else { target.classList.add('empty'); target.innerHTML = ''; }
      const msg = err && err.message ? err.message : String(err);
      const box = document.createElement('div');
      box.className = 'err-box md';
      box.textContent = aborted ? '■ 已停止生成。' : '⚠️ ' + msg;
      target.appendChild(box);
      if (!aborted) {
        const hintEl = document.createElement('div');
        hintEl.className = 'tiny muted';
        hintEl.style.marginTop = '6px';
        hintEl.textContent = '可在「设置」里检查 Base URL / API Key / 模型名，或勾选「演示模式」先看界面。';
        target.appendChild(hintEl);
        // 模型名错误：自动拉取接口支持的模型，点一下即可切换并重试
        if (/model|模型/i.test(msg) && /support|支持|invalid|not found|不存在/i.test(msg)) {
          S.lastRun = opts;
          try {
            const cfg = API.cfg();
            const list = await API.models(cfg.baseUrl, cfg.apiKey);
            if (list.length) {
              const wrap = document.createElement('div');
              wrap.style.marginTop = '8px';
              wrap.innerHTML = '<div class="tiny" style="margin-bottom:5px">接口实际支持的模型（点一下自动切换并重试）：</div>' +
                list.map(m => '<button class="btn small-btn" data-act="use-model" data-v="' + esc(m) + '">' + esc(m) + '</button>').join(' ');
              target.appendChild(wrap);
            }
          } catch (e2) { /* 拉取失败就保持原提示 */ }
        }
      }
      if (S.outs[outKey]) attachTools(outKey, S.outs[outKey], opts.extraTools || TOOL_EXTRA[outKey]);
      else {
        const tl = document.getElementById('tools-' + outKey);
        if (tl) tl.innerHTML = '';
      }
    } finally {
      S.busy = false; S.abort = null;
      document.body.classList.remove('generating');
    }
  }

  /* ---------------------------------------------------------- chat */
  async function runAsk() {
    const ta = $('#askInput');
    const q = ta ? ta.value.trim() : '';
    if (!q) { toast('先写一个问题'); return; }
    if (S.busy) { toast('正在生成，请稍候…'); return; }
    S.busy = true;
    document.body.classList.add('generating');
    const out = $('#out-chat');
    ta.value = '';
    S.chat.display.push({ role: 'user', text: q });
    renderChatLog();
    const bubble = document.createElement('div');
    bubble.className = 'chat-assistant md live';
    out.appendChild(bubble);
    S.chat.display.push({ role: 'assistant', text: '', el: bubble });
    const ac = new AbortController();
    S.abort = ac;
    const secText = await getSectionText(S.section && S.section.id);
    try {
      let messages;
      if (!S.chat.first) {
        const built = await PROMPTS.build('ask', { text: (secText || '').slice(0, 14000), question: q });
        S.chat.first = built[1].content;
        S.chat.msgs = [built[1]];
        messages = built;
      } else {
        const sys = await PROMPTS.raw('system');
        messages = [{ role: 'system', content: sys }].concat(S.chat.msgs, [{ role: 'user', content: q }]);
        S.chat.msgs.push({ role: 'user', content: q });
      }
      let text = '';
      let lastLen = -1;
      const timer = setInterval(() => {
        if (text.length !== lastLen) { lastLen = text.length; bubble.innerHTML = md(text); }
      }, 130);
      if (API.isDemo()) {
        const t = await PROMPTS.demo('ask', { question: q });
        await typeOut(t, d => { text += d; }, ac.signal);
      } else {
        await API.stream(messages, { signal: ac.signal, onDelta: d => { text += d; } });
      }
      clearInterval(timer);
      bubble.innerHTML = md(text);
      renderMath(bubble);
      S.chat.msgs.push({ role: 'assistant', content: text });
      S.chat.display[S.chat.display.length - 1].text = text;
      saveArchive({
        chat: {
          first: S.chat.first,
          msgs: S.chat.msgs,
          display: S.chat.display.map(m => ({ role: m.role, text: m.text }))
        }
      });
    } catch (err) {
      bubble.innerHTML = '<div class="err-box">⚠️ ' + esc(err && err.message ? err.message : String(err)) + '</div>';
    } finally {
      S.busy = false; S.abort = null;
      document.body.classList.remove('generating');
      const body = $('#workBody');
      if (body) U.scrollToBottom(body);
    }
  }

  function renderChatLog() {
    const out = $('#out-chat');
    if (!out) return;
    out.innerHTML = S.chat.display.map(m => {
      if (m.role === 'user') return '<div class="chat-q"><b>问：</b>' + esc(m.text) + '</div>';
      return '<div class="md live">' + md(m.text) + '</div>';
    }).join('') || '<div class="tiny muted">还没有对话。先问一个具体问题，例如"为什么 Buck 的 M(D) 与负载无关？"</div>';
  }

  /* ---------------------------------------------------------- selection bar */
  let selBarTimer = null;
  let draftSaveTimer = null;
  let termAbort = null;
  function hideSelBar() { const b = $('#selBar'); if (b) b.classList.add('hidden'); }
  function hideTermPop() {
    const p = $('#termPop');
    if (p) p.classList.add('hidden');
    if (termAbort) { try { termAbort.abort(); } catch (e) {} termAbort = null; }
  }

  function isShortTerm(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return t.length <= 48 && !/[\n。！？；：]/.test(t) && t.split(/\s+/).length <= 6;
  }

  function setupSelection() {
    document.addEventListener('mouseup', () => {
      clearTimeout(selBarTimer);
      selBarTimer = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) { hideSelBar(); return; }
        const text = sel.toString().trim();
        if (text.length < 2) { hideSelBar(); return; }
        const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
        if (!node || !node.closest('#textPane, .md, .out')) { hideSelBar(); return; }
        S.selectedText = text.slice(0, 4000);
        S.pendingRanges = captureSelectionRanges();
        const para = node.closest('.para');
        S.selContext = para ? para.textContent.replace(/精读\s*$/, '').trim().slice(0, 600) : text.slice(0, 600);
        const bar = $('#selBar');
        const prev = $('#selPreview');
        if (prev) prev.textContent = S.selectedText.slice(0, 22) + (S.selectedText.length > 22 ? '…' : '');
        const cardsBtn = bar.querySelector('[data-sel="cards"]');
        const short = isShortTerm(S.selectedText);
        if (cardsBtn) cardsBtn.textContent = short ? '⚡ 查词' : '术语卡';
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        S.selRect = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        bar.classList.remove('hidden');
        const top = Math.min(window.innerHeight - 60, rect.bottom + 8);
        const left = Math.max(12, Math.min(window.innerWidth - 340, rect.left));
        bar.style.top = top + 'px';
        bar.style.left = left + 'px';
      }, 20);
    });
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#selBar')) hideSelBar();
      if (!e.target.closest('#termPop')) hideTermPop();
      if (!e.target.closest('#hlPop')) hideHlPop();
    });
    document.addEventListener('scroll', hideSelBar, true);
  }

  /* ---------------------------------------------------------- 术语速查浮层 */
  function positionTermPop() {
    const pop = $('#termPop');
    if (!pop || pop.classList.contains('hidden')) return;
    const r = S.selRect || { left: 40, top: 120, bottom: 140 };
    const w = pop.offsetWidth || 340;
    const h = pop.offsetHeight || 120;
    const left = Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  async function quickTerm() {
    const term = String(S.selectedText || '').trim();
    if (!term) return;
    hideSelBar();
    const pop = $('#termPop');
    if (!pop) return;
    const termRanges = (S.pendingRanges && S.pendingRanges.length) ? S.pendingRanges.slice() : captureSelectionRanges();
    const body = $('#tpBody'), head = $('#tpTerm');
    const saveBtn = pop.querySelector('[data-act="term-save"]');
    head.textContent = term.length > 40 ? term.slice(0, 40) + '…' : term;
    pop.classList.remove('hidden');
    positionTermPop();

    const key = (S.section ? S.section.id : '') + '|' + term.toLowerCase();
    const cached = S.termCache[key];
    if (cached) {
      body.classList.remove('loading');
      S.termLastText = cached;
      syncLookupWord(term, cached, { silent: true });
      U.renderMarkdown(body, cached);
      if (saveBtn) saveBtn.disabled = false;
      if (termRanges.length) addTermHighlights(termRanges, compactMeaning(cached, term));
      positionTermPop();
      return;
    }
    body.classList.add('loading');
    body.textContent = '查询中…';
    if (saveBtn) saveBtn.disabled = true;
    termAbort = new AbortController();
    let text = '';
    const t0 = performance.now();
    try {
      if (API.isDemo()) {
        const t = await PROMPTS.demo('termQuick', { term });
        await typeOut(t, d => { text += d; body.textContent = text; }, termAbort.signal);
      } else {
        const msgs = await PROMPTS.build('termQuick', Object.assign({ term, context: S.selContext || '' }, ctxBase()));
        await API.stream(msgs, {
          signal: termAbort.signal,
          maxTokens: 220,
          temperature: 0.2,
          onDelta: d => { text += d; body.classList.remove('loading'); body.textContent = text; }
        });
      }
      S.termCache[key] = text;
      S.termLastText = text;
      if (text.trim()) syncLookupWord(term, text);
      S.termLastMs = Math.round(performance.now() - t0);
      body.classList.remove('loading');
      if (text.trim()) U.renderMarkdown(body, text);
      else body.textContent = '（没有返回内容）';
      if (saveBtn) saveBtn.disabled = false;
      if (termRanges.length && text.trim()) {
        addTermHighlights(termRanges, compactMeaning(text, term));
      }
      positionTermPop();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      body.classList.remove('loading');
      body.textContent = '⚠️ ' + (e && e.message ? e.message : e);
      if (saveBtn) saveBtn.disabled = true;
    } finally {
      termAbort = null;
    }
  }

  function saveQuickTerm() {
    const term = String(S.selectedText || '').trim();
    const text = String(S.termLastText || (($('#tpBody') || {}).textContent || '')).trim();
    if (!term || !text) return toast('还没有查询结果');
    const r = wbAdd({
      en: term,
      zh: wbExtractZh(text),
      note: compactMeaning(text, term),
      cat: classifyTerm(term, text),
      src: S.chapter ? ('第' + S.chapter.num + '章') : '',
      source: 'lookup'
    });
    saveGlossary(); updateCounts();
    if (r) toast('已加入单词本 · ' + wbCatName(r.item.cat));
  }

  function fullTermCardFromPop() {
    const term = String(S.selectedText || '').trim();
    hideTermPop();
    S.closeTab = 'cards';
    S.workTab = 'close';
    renderWork();
    const ta = $('#cardsInput');
    if (ta) ta.value = term;
    S.drafts.cards = term;
    ACTIONS['run-cards']();
  }

  /* ---------------------------------------------------------- page views */
  const VIEW_TITLES = { plan: '学习计划', glossary: '单词本', review: '单词复习', mistakes: '错题本', quiz: '周测', archive: '学习存档', settings: '设置' };

  function showView(name) {
    const study = $('#studyView'), page = $('#pageView');
    if (!page || !study) return;
    S.view = name;
    if (name === 'study') {
      page.classList.add('hidden');
      study.classList.remove('hidden');
      return;
    }
    if (!VIEWS[name]) return;
    study.classList.add('hidden');
    page.classList.remove('hidden');
    $('#pageTitle').textContent = VIEW_TITLES[name] || name;
    $('#pageBody').innerHTML = VIEWS[name]();
    if (name === 'quiz') restoreQuizView();
  }

  function restoreQuizView() {
    if (S.quiz.q) {
      const el = document.getElementById('quizOut');
      if (el) { el.classList.remove('empty'); U.renderMarkdown(el, S.quiz.q); }
      attachTools('quiz', S.quiz.q, '<button class="btn small-btn" data-act="quiz-save-mistakes">存入错题本</button>');
    }
    if (S.quiz.fb) {
      const el = document.getElementById('quizFb');
      if (el) U.renderMarkdown(el, S.quiz.fb);
    }
  }

  /* ---------------------------------------------------------- settings */
  function openSettings() {
    const c = API.cfg();
    $('#cfgBase').value = c.baseUrl || '';
    $('#cfgKey').value = c.apiKey || '';
    $('#cfgModel').value = c.model || '';
    $('#cfgTemp').value = c.temperature;
    $('#cfgDemo').checked = !!c.demo;
    const ab = $('#cfgAutoBackup');
    if (ab) ab.checked = S.ui.autoBackup !== false;
    const th = $('#cfgTheme');
    if (th) th.value = S.ui.theme || 'light';
    refreshBackupInfo();
    $('#cfgProvider').value = /deepseek/i.test(c.baseUrl) ? 'deepseek' : (/openai\.com/i.test(c.baseUrl) ? 'openai' : 'custom');
    $('#testResult').textContent = '';
    $('#testResult').className = 'test-result';
    $('#modelChips').innerHTML = '';
    $('#modelHint').textContent = '不同接口支持的模型名不同（如 deepseek-chat / deepseek-flash / deepseek-v4-pro）。点「获取可用模型」直接从接口拉取，避免写错。';
    $('#modal').classList.remove('hidden');
  }

  /* ---------------------------------------------------------- 自定义提示词 */
  const PROMPT_LABELS = {
    system: '全局 system 提示（角色 / 风格 / 公式规范）',
    pre: '① 读前预习', preAnswers: '读前问题解答', close: '② 四栏精读', formula: '公式拆解',
    cards: '术语卡', termQuick: '⚡ 查词速查',
    hlTranslate: '高亮 · AI 翻译', hlSummary: '高亮 · AI 总结',
    ask: '追问',
    freeQa: '自由问答', questions: '练习 · 出题', grade: '练习 · 批改',
    feynmanQ: '费曼 · 学生提问', feynmanDiag: '费曼 · 诊断',
    pack: '⑤ 学习包', packNotes: '长文分块笔记（内部用）', mergeNotes: '长文合并（内部用）',
    chapterSummary: '章节知识提纲', probSolve: '习题解答', probAll: '习题全解',
    probFeynmanQ: '习题费曼 · 提问', probFeynmanDiag: '习题费曼 · 诊断', quiz: '周测'
  };
  let promptNamesCache = null;

  function placeholdersOf(txt) {
    const out = [];
    String(txt || '').replace(/\{\{(\w+)\}\}/g, (all, k) => { if (out.indexOf(k) < 0) out.push(k); return all; });
    return out;
  }

  async function openPromptEditor() {
    $('#promptModal').classList.remove('hidden');
    try {
      if (!promptNamesCache) promptNamesCache = await PROMPTS.names();
    } catch (e) {
      toast('提示词文件加载失败：' + (e.message || e));
      return;
    }
    const sel = $('#promptTaskSel');
    sel.innerHTML = promptNamesCache.map(n => '<option value="' + escAttr(n) + '">' +
      esc((PROMPT_LABELS[n] || n) + '（' + n + '）') + '</option>').join('');
    await loadPromptTask(promptNamesCache[0]);
  }

  async function loadPromptTask(name) {
    const preset = await PROMPTS.preset(name);
    const custom = (S.customPrompts || {})[name];
    $('#promptText').value = (custom !== undefined && custom !== '') ? custom : preset;
    const ph = placeholdersOf(preset);
    $('#promptTaskMeta').textContent = custom ? '状态：已自定义（点保存生效）' : '状态：使用内置预设';
    $('#promptHint').textContent = '可用占位符：' + (ph.length ? ph.map(p => '{{' + p + '}}').join('、') : '（无）') +
      ' —— 会被自动替换；保存后立即生效，已生成的内容不受影响。';
  }

  async function savePromptTask() {
    const name = $('#promptTaskSel').value;
    const txt = $('#promptText').value;
    const preset = await PROMPTS.preset(name);
    if (!name) return;
    if (!txt.trim()) return toast('内容为空，请用「恢复此任务默认」来清除');
    if (txt === preset) { delete (S.customPrompts || {})[name]; }
    else { S.customPrompts = S.customPrompts || {}; S.customPrompts[name] = txt; }
    PROMPTS.setCustom(S.customPrompts);
    savePrompts();
    await loadPromptTask(name);
    toast(txt === preset ? '已恢复为内置预设' : '自定义提示词已保存并生效');
  }

  async function resetPromptTask(name) {
    if (S.customPrompts) delete S.customPrompts[name];
    PROMPTS.setCustom(S.customPrompts || {});
    savePrompts();
    await loadPromptTask(name);
    toast('已恢复该任务的内置预设');
  }

  async function fetchModels() {
    const btn = $('#btnFetchModels');
    const base = ($('#cfgBase').value || '').trim();
    const key = ($('#cfgKey').value || '').trim();
    const hint = $('#modelHint');
    const chips = $('#modelChips');
    if (!base) { toast('先填 Base URL'); return; }
    if (!key) { toast('先填 API Key'); return; }
    btn.disabled = true;
    btn.textContent = '获取中…';
    hint.textContent = '正在请求 ' + base + '/models …';
    try {
      const list = await API.models(base, key);
      if (!list.length) {
        hint.textContent = '接口没有返回模型列表（部分服务不开放 /models）。可以手动填写模型名。';
      } else {
        const dl = $('#modelList');
        dl.innerHTML = list.map(m => '<option value="' + esc(m) + '">').join('');
        chips.innerHTML = list.map(m =>
          '<button type="button" class="chip" data-act="pick-model" data-v="' + esc(m) + '">' + esc(m) + '</button>').join('');
        const cur = ($('#cfgModel').value || '').trim();
        hint.textContent = '该接口支持 ' + list.length + ' 个模型：' + list.join('、') +
          (list.includes(cur) ? '' : '。当前填写的「' + (cur || '空') + '」不在列表里，点下面的模型名自动填入。');
      }
    } catch (e) {
      hint.textContent = '获取失败：' + (e.message || e) + '。可手动填写模型名。';
    } finally {
      btn.disabled = false;
      btn.textContent = '获取可用模型';
    }
  }

  function applyProviderPreset() {
    const p = $('#cfgProvider').value;
    if (p === 'deepseek') {
      if (!$('#cfgBase').value || /openai|localhost|127\.0\.0\.1/i.test($('#cfgBase').value)) { $('#cfgBase').value = 'https://api.deepseek.com/v1'; }
      if (!$('#cfgModel').value || /gpt|llama|qwen/i.test($('#cfgModel').value)) { $('#cfgModel').value = 'deepseek-chat'; }
      $('#providerHint').textContent = 'DeepSeek 控制台：platform.deepseek.com → API keys。推荐模型 deepseek-chat。';
    } else if (p === 'openai') {
      $('#cfgBase').value = 'https://api.openai.com/v1';
      $('#cfgModel').value = 'gpt-4o-mini';
      $('#providerHint').textContent = 'OpenAI 兼容接口；国内需自备网络环境。';
    } else {
      $('#providerHint').textContent = '任何 OpenAI 兼容服务：本地 Ollama（http://localhost:11434/v1）、vLLM、硅基流动等。';
    }
  }

  function saveSettings() {
    const cfg = {
      baseUrl: $('#cfgBase').value.trim() || 'https://api.deepseek.com/v1',
      apiKey: $('#cfgKey').value.trim(),
      model: $('#cfgModel').value.trim() || 'deepseek-chat',
      temperature: parseFloat($('#cfgTemp').value) || 0.4,
      demo: $('#cfgDemo').checked
    };
    const themeSel = $('#cfgTheme');
    if (themeSel) { S.ui.theme = themeSel.value || 'light'; saveUi(); applyTheme(); }
    API.saveCfg(cfg);
    updateStatusPill();
    toast('设置已保存');
    $('#modal').classList.add('hidden');
  }

  async function testApi() {
    const btn = $('#btnTestApi');
    const res = $('#testResult');
    btn.disabled = true;
    res.className = 'test-result';
    res.textContent = '测试中…';
    try {
      // 临时保存再测试
      API.saveCfg({
        baseUrl: $('#cfgBase').value.trim(),
        apiKey: $('#cfgKey').value.trim(),
        model: $('#cfgModel').value.trim(),
        temperature: parseFloat($('#cfgTemp').value) || 0.4,
        demo: false
      });
      const txt = await API.test();
      res.className = 'test-result ok';
      res.textContent = '✅ 连接成功，模型回复：' + txt;
    } catch (e) {
      res.className = 'test-result err';
      res.textContent = '❌ 失败：' + (e.message || e) + '\n常见原因：Key 错误 / Base URL 不含 /v1 / 余额不足 / 网络不通。';
    } finally {
      btn.disabled = false;
      updateStatusPill();
    }
  }

  function updateStatusPill() {
    const pill = $('#apiStatus');
    if (!pill) return;
    const c = API.cfg();
    const demo = API.isDemo();
    pill.textContent = demo ? (c.demo ? '演示模式' : '未配置 API') : (c.model || 'API 已配置');
    pill.className = 'pill ' + (demo ? (c.demo ? 'pill-demo' : 'pill-warn') : 'pill-ok');
  }

  function collectData() {
    return {
      version: 3, exported: nowStr(),
      progress: S.progress, glossary: S.glossary, mistakes: S.mistakes,
      notes: S.notes, plan: S.plan, pos: S.pos, expanded: S.expanded,
      archive: S.archive, highlights: S.highlights, done: S.done,
      planCfg: S.planCfg,
      prompts: S.customPrompts || {},
      ui: { autoBackup: S.ui.autoBackup !== false, theme: S.ui.theme || 'light' },
      reviewDays: store.get('reviewDays', [])
    };
  }

  function exportAll() {
    downloadFile('电力电子学习台-备份-' + today() + '.json', JSON.stringify(collectData(), null, 1), 'application/json');
    toast('已导出备份（不含 API Key）');
  }

  function importAll(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(String(reader.result));
        if (d.progress) { S.progress = d.progress; saveProgress(); }
        if (d.glossary) { S.glossary = d.glossary; saveGlossary(); }
        if (d.mistakes) { S.mistakes = d.mistakes; saveMistakes(); }
        if (d.notes) { S.notes = d.notes; store.set('notes', S.notes); }
        if (d.plan) { S.plan = d.plan; savePlan(); }
        if (d.planCfg) { S.planCfg = d.planCfg; savePlanCfg(); }
        if (d.pos) { S.pos = d.pos; store.set('pos', S.pos); }
        if (d.expanded) { S.expanded = d.expanded; saveExpanded(); }
        if (d.archive) { S.archive = d.archive; store.set('archive', S.archive); }
        if (d.highlights) { S.highlights = d.highlights; saveHighlights(); }
        if (d.done) { S.done = d.done; saveDone(); }
        if (d.prompts) { S.customPrompts = d.prompts; savePrompts(); }
        if (d.ui && d.ui.autoBackup !== undefined) { S.ui.autoBackup = !!d.ui.autoBackup; saveUi(); }
        if (d.ui && d.ui.theme) { S.ui.theme = d.ui.theme; saveUi(); applyTheme(); }
        if (d.reviewDays) store.set('reviewDays', d.reviewDays);
        normalizeGlossary();
        migrateLookupHistory(true);
        reclassifyWordbook();
        renderToc(); showView('study'); toast('备份已导入');
      } catch (e) { toast('导入失败：文件格式不对'); }
    };
    reader.readAsText(file);
  }

  /* ---------------------------------------------------------- 自动备份（写本地文件） */
  let backupTimer = null;
  let backupBusy = false;

  function scheduleAutoBackup() {
    if (S.ui.autoBackup === false) return;
    if (backupTimer) return;
    backupTimer = setTimeout(() => {
      backupTimer = null;
      doAutoBackup('auto');
    }, 90 * 1000);
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n > 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  async function doAutoBackup(reason) {
    if (backupBusy) return null;
    backupBusy = true;
    try {
      const r = await API.backup(collectData(), reason || 'auto');
      store.set('lastAutoBackup', { at: nowStr(), name: r && r.name, size: r && r.size });
      const info = $('#backupInfo');
      if (info) info.textContent = '最近备份：' + nowStr() + '（' + ((r && r.name) || '已保存') + '）';
      return r;
    } catch (e) {
      const info = $('#backupInfo');
      if (info) info.textContent = '备份失败：' + (e.message || e);
      return null;
    } finally {
      backupBusy = false;
    }
  }

  async function refreshBackupInfo() {
    const info = $('#backupInfo');
    if (!info) return;
    const last = store.get('lastAutoBackup', null);
    let txt = last && last.at ? ('最近备份：' + last.at + '（' + (last.name || '') + '）') : '还没有自动备份';
    try {
      const r = await API.backups();
      const n = (r && r.backups && r.backups.length) || 0;
      txt += ' · 备份文件夹共 ' + n + ' 份';
      if (n && r.backups[0]) txt += '，最新 ' + r.backups[0].time + '（' + fmtBytes(r.backups[0].size) + '）';
    } catch (e) { /* 忽略 */ }
    info.textContent = txt;
  }

  /* ---------------------------------------------------------- actions */
  async function withSection(fn) {
    if (!S.section) { toast('请先在左侧选择一个章节'); return; }
    return fn();
  }

  const ACTIONS = {
    'open-chapter': (el) => openChapter(el.dataset.id),
    'open-section': (el) => openSection(el.dataset.id),
    'toggle-chapter': (el) => {
      const id = el.dataset.id;
      S.expanded[id] = !S.expanded[id];
      saveExpanded();
      renderToc();
    },
    'toggle-ch-done': (el) => {
      const id = el.dataset.id;
      if (S.done[id]) delete S.done[id];
      else S.done[id] = 1;
      saveDone();
      renderToc();
      const ch = findChapter(id);
      toast(S.done[id] ? ('已标记「第' + (ch ? ch.num : '') + '章」为学完') : '已取消「本章已学完」标记');
    },
    'toggle-part-done': (el) => {
      const pid = el.dataset.id;
      const part = (S.book.parts || []).find(p => p.id === pid);
      if (!part) return;
      const allDone = part.chapters.every(ch => isChapterDone(ch));
      part.chapters.forEach(ch => {
        if (allDone) delete S.done[ch.id];
        else S.done[ch.id] = 1;
      });
      saveDone();
      renderToc();
      toast(allDone ? '已取消该 Part 的学完标记' : '已把 ' + part.title + ' 标记为学完');
    },

    'reader-text': () => setReaderTab('text'),
    'para-read': (el) => { S.closeTab = 'four'; S.drafts.close = (S.currentParas || [])[Number(el.dataset.i)] || ''; S.workTab = 'close'; renderWork(); },

    'close-tab': (el) => { S.closeTab = el.dataset.v; renderWork(); },

    'run-pre': async () => {
      await withSection(async () => {
        const useText = $('#preUseText') && $('#preUseText').checked;
        const text = useText ? sectionTextForPre(await getSectionText(S.section.id)) : '';
        delete S.outs.preAnswers;   // 题目重出，旧解答作废
        saveArchive({ preAnswers: '' });
        await generate({
          task: 'pre',
          ctx: Object.assign(ctxBase(), { text, learned: learnedContext().text }),
          outKey: 'pre',
          after: () => { markStage('pre'); renderWork(); }
        });
      });
    },
    'run-pre-answers': async () => {
      if (!S.outs.pre) { toast('先生成读前问题'); return; }
      await withSection(async () => {
        const text = sectionTextForPre(await getSectionText(S.section.id));
        await generate({
          task: 'preAnswers',
          ctx: Object.assign(ctxBase(), { questions: S.outs.pre, text }),
          outKey: 'preAnswers',
          after: () => renderWork()
        });
      });
    },
    'run-close': async () => {
      const ta = $('#closeInput');
      const text = (ta.value || '').trim();
      if (!text) { toast('先粘贴或选中一段英文原文'); return; }
      S.drafts.close = text;
      await generate({ task: 'close', ctx: { text }, outKey: 'close', after: () => markStage('close') });
    },
    'fill-first-para': async () => {
      if (!S.section) return toast('先选小节');
      const text = await getSectionText(S.section.id);
      const cands = text.split(/\n{2,}/).filter(p => p.trim());
      const first = cands.find(p => p.length > 90 && /[a-z]{3,}\s+[a-z]{3,}/.test(p) && /[.,;]/.test(p)) ||
        cands.find(p => p.trim().length > 40) || text.slice(0, 600);
      const ta = $('#closeInput');
      if (ta) ta.value = first.trim();
      toast('已填入本节第一段正文');
    },
    'run-formula': async () => {
      const ta = $('#formulaInput');
      const text = (ta.value || '').trim();
      if (!text) { toast('先输入公式或推导步骤'); return; }
      S.drafts.formula = text;
      await generate({ task: 'formula', ctx: { text }, outKey: 'formula' });
    },
    'run-cards': async () => {
      const ta = $('#cardsInput');
      const text = (ta.value || '').trim() || (S.section ? (await getSectionText(S.section.id)).slice(0, 5000) : '');
      if (!text) { toast('先粘贴原文或写主题'); return; }
      S.drafts.cards = text;
      await generate({ task: 'cards', ctx: { text }, outKey: 'cards' });
    },
    'run-ask': () => runAsk(),
    'run-qa': () => runFreeAsk(),
    'clear-qa': () => {
      S.qa = { first: '', msgs: [], display: [], useText: S.qa ? S.qa.useText : true, useChapter: S.qa ? !!S.qa.useChapter : false };
      saveQaArchive();
      renderWork();
    },
    'clear-chat': () => {
      S.chat = { first: '', msgs: [], display: [] };
      saveArchive({ chat: { first: '', msgs: [], display: [] } });
      renderWork();
    },
    'term-close': () => hideTermPop(),
    'term-save': () => saveQuickTerm(),
    'term-full': () => fullTermCardFromPop(),
    'hl-close': () => hideHlPop(),
    'hl-color': (el) => setHlColor(el.dataset.v),
    'hl-ai': (el) => hlAi(el.dataset.v),
    'hl-save': () => saveHlDraft(),

    'p-type': (el) => { S.practice.type = el.dataset.v; renderWork(); },
    'p-level': (el) => { S.practice.level = el.dataset.v; renderWork(); },
    'run-practice': async () => {
      await withSection(async () => {
        const nEl = $('#pN');
        const p = S.practice;
        if (nEl) p.n = parseInt(nEl.value, 10) || 3;
        const useProbs = $('#pProbs') ? $('#pProbs').checked : true;
        p.useProbs = useProbs;
        p.q = ''; p.a = ''; p.fb = '';
        delete S.outs.practiceQ; delete S.outs.practiceFB;
        let probs = '';
        if (useProbs) {
          try { const r = await API.probs(S.chapter.id); probs = (r.text || '').slice(0, 5000); } catch (e) { /* ignore */ }
        }
        await generate({
          task: 'questions',
          ctx: Object.assign(ctxBase(), { type: p.type, n: p.n, level: p.level, probs }),
          outKey: 'practiceQ',
          extraTools: '<button class="btn small-btn" data-act="scroll-answer">去作答 ↓</button>',
          after: (text) => { p.q = text; S.outs.practiceQ = text; renderWork(); }
        });
      });
    },
    'practice-reset': () => {
      S.practice.q = ''; S.practice.a = ''; S.practice.fb = '';
      delete S.outs.practiceQ; delete S.outs.practiceFB;
      saveArchive({ practiceQ: '', practiceA: '', practiceFB: '' });
      renderWork();
    },
    'scroll-answer': () => { const el = $('#pAnswer'); if (el) { el.focus(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } },
    'run-grade': async () => {
      const p = S.practice;
      const ta = $('#pAnswer');
      if (!p.q) return toast('先出题');
      const ans = ta ? ta.value.trim() : '';
      if (!ans) { toast('先写下你的解答'); return; }
      p.a = ans;
      await generate({
        task: 'grade',
        ctx: { questions: p.q, answers: ans },
        outKey: 'practiceFB',
        extraTools: '<button class="btn small-btn" data-act="save-mistake">存入错题本</button>',
        after: (text) => {
          p.fb = text; S.outs.practiceFB = text;
          saveArchive({ practiceQ: p.q, practiceA: ans, practiceFB: text });
          markStage('practice');
          const el = document.getElementById('out-practiceFB');
          if (el) U.renderMarkdown(el, text);
          attachTools('practiceFB', text, '<button class="btn small-btn" data-act="save-mistake">存入错题本</button>');
          renderWork();
        }
      });
    },
    'save-mistake': () => {
      const p = S.practice;
      if (!p.q || !p.fb) return toast('还没有批改结果');
      S.mistakes.unshift({
        id: uid(), date: nowStr(), chapter: S.chapter ? ('第' + S.chapter.num + '章 ' + S.chapter.title) : '',
        source: '练习', question: p.q, answer: p.a, feedback: p.fb
      });
      saveMistakes(); updateCounts();
      toast('已存入错题本');
    },

    'run-feynman-q': async () => {
      const f = S.feynman;
      const topic = ($('#fyTopic') || {}).value || '';
      const text = ($('#fyText') || {}).value || '';
      if (text.trim().length < 40) { toast('讲解太短了，至少写 40 字（这是费曼法的关键）'); return; }
      f.topic = topic; f.text = text;
      const secText = S.section ? (await getSectionText(S.section.id)).slice(0, 6000) : '';
      await generate({
        task: 'feynmanQ',
        ctx: { topic, text, sectionText: secText },
        outKey: 'feynmanQ',
        after: (t) => {
          f.q = t;
          saveArchive({ feynmanTopic: f.topic, feynmanText: f.text, feynmanQ: t });
          renderWork();
        }
      });
    },
    'run-feynman-diag': async () => {
      const f = S.feynman;
      const answers = ($('#fyAnswer') || {}).value || '';
      if (answers.trim().length < 10) { toast('先回答上面的问题'); return; }
      f.a = answers;
      await generate({
        task: 'feynmanDiag',
        ctx: { topic: f.topic, text: f.text, questions: f.q, answers },
        outKey: 'feynmanDiag',
        after: (t) => {
          f.diag = t;
          saveArchive({ feynmanTopic: f.topic, feynmanText: f.text, feynmanQ: f.q, feynmanA: answers, feynmanDiag: t });
          renderWork();
        }
      });
    },
    'feynman-reset': () => {
      S.feynman = { topic: '', text: '', q: '', a: '', diag: '' };
      saveArchive({ feynmanTopic: '', feynmanText: '', feynmanQ: '', feynmanA: '', feynmanDiag: '' });
      renderWork();
    },
    'feynman-save': () => saveNoteAs('费曼-' + (S.feynman.topic || ''), S.feynman.diag),

    'run-prob-feynman-q': async () => {
      const f = S.feynman;
      const topic = ($('#fyTopic') || {}).value || '';
      const text = ($('#fyText') || {}).value || '';
      if (text.trim().length < 40) { toast('讲解太短了，至少写 40 字（这是费曼法的关键）'); return; }
      f.topic = topic; f.text = text;
      const context = await probFeynmanContext();
      await generate({
        task: 'probFeynmanQ',
        ctx: { num: S.chapter ? S.chapter.num : '', title: S.chapter ? S.chapter.title : '', topic, text, context },
        outKey: 'feynmanQ',
        after: (t) => {
          f.q = t;
          saveArchive({ feynmanTopic: f.topic, feynmanText: f.text, feynmanQ: t });
          renderWork();
        }
      });
    },
    'run-prob-feynman-diag': async () => {
      const f = S.feynman;
      const answers = ($('#fyAnswer') || {}).value || '';
      if (answers.trim().length < 10) { toast('先回答上面的问题'); return; }
      f.a = answers;
      const context = await probFeynmanContext();
      await generate({
        task: 'probFeynmanDiag',
        ctx: {
          num: S.chapter ? S.chapter.num : '', title: S.chapter ? S.chapter.title : '',
          topic: f.topic, text: f.text, questions: f.q, answers, context
        },
        outKey: 'feynmanDiag',
        after: (t) => {
          f.diag = t;
          saveArchive({ feynmanTopic: f.topic, feynmanText: f.text, feynmanQ: f.q, feynmanA: answers, feynmanDiag: t });
          renderWork();
        }
      });
    },
    'prob-feynman-reset': () => {
      S.feynman = { topic: '', text: '', q: '', a: '', diag: '' };
      saveArchive({ feynmanTopic: '', feynmanText: '', feynmanQ: '', feynmanA: '', feynmanDiag: '' });
      renderWork();
    },

    'pack-scope': (el) => { S.pack.scope = el.dataset.v; savePack(); renderWork(); },
    'pack-part': (el) => {
      const id = el.dataset.v;
      const set = new Set(S.pack.parts || []);
      if (el.checked) set.add(id); else set.delete(id);
      S.pack.parts = PACK_PARTS.filter(pp => set.has(pp.id)).map(pp => pp.id);
      savePack();
    },
    'pack-preset': (el) => {
      const v = el.dataset.v;
      if (v === 'all') S.pack.parts = PACK_DEFAULT.slice();
      else if (v === 'none') S.pack.parts = [];
      else if (v === 'summary') S.pack.parts = ['brief', 'map', 'outline', 'core', 'errors', 'terms'];
      savePack();
      renderWork();
    },
    'run-pack': async () => {
      if (!S.chapter) return toast('先选章节');
      const sel = S.pack.parts || [];
      const specParts = PACK_PARTS.filter(pp => sel.indexOf(pp.id) >= 0).map(pp => pp.tpl).join('\n\n');
      if (!specParts) return toast('先勾选要生成的内容');
      let num, title, text;
      if (S.pack.scope === 'chapter') {
        num = S.chapter.num; title = S.chapter.title;
        try {
          const cf = await API.chapterFull(S.chapter.id);
          text = (cf && cf.text) || '';
          if (cf && cf.chars && cf.chars > text.length) { /* 仍用完整文本 */ }
        } catch (e) {
          text = await getChapterContext(S.chapter.id, 45000);
        }
        if (!text) text = await getChapterContext(S.chapter.id, 45000);
      } else {
        if (!S.section) return toast('先选小节');
        num = S.section.num; title = S.section.title;
        text = await getSectionText(S.section.id);
      }
      const baseCtx = { num, title, text, sections: specParts };
      const specFull = '# 第' + num + '章 ' + title + ' · 学习包\n\n' + specParts;
      if (text.length > MAPREDUCE_THRESHOLD) {
        toast('原文 ' + text.length + ' 字符：先分块提炼要点再合并，内容更完整但会慢一些', 3000);
        await generate({
          task: 'pack', ctx: baseCtx, outKey: 'pack', extraTools: TOOL_EXTRA.pack,
          prep: (status) => packNotesPrep(num, title, text, specFull, status)
        });
      } else {
        await generate({ task: 'pack', ctx: baseCtx, outKey: 'pack', extraTools: TOOL_EXTRA.pack });
      }
    },

    'run-prob-solve': async () => {
      if (!S.section || !S.section.isProblems) return;
      const noEl = $('#probNo'), qEl = $('#probQ');
      S.prob.qno = noEl ? noEl.value.trim() : S.prob.qno;
      S.prob.question = qEl ? qEl.value.trim() : S.prob.question;
      if (!S.prob.qno && !S.prob.question) return toast('先填题号，或把题干粘贴到下面');
      const text = await getSectionText(S.section.id);
      await generate({
        task: 'probSolve',
        ctx: {
          num: S.chapter ? S.chapter.num : '', title: S.chapter ? S.chapter.title : '',
          qno: S.prob.qno || '（见题干）', question: S.prob.question || '（见教材习题原文）',
          text: (text || '').slice(0, 20000)
        },
        outKey: 'probSolve',
        extraTools: TOOL_EXTRA.probSolve,
        after: (outText) => {
          saveProbSolve({ qno: S.prob.qno, question: S.prob.question, text: outText });
          renderWork();
        }
      });
    },
    'prob-sol-del': (el) => {
      const id = el.dataset.id;
      S.probSolves = (S.probSolves || []).filter(x => x.id !== id);
      if (S.section) saveArchive({ probSolves: S.probSolves });
      renderWork();
      toast('已删除这条解答');
    },
    'prob-first': async () => {
      if (!S.section || !S.section.isProblems) return;
      const text = await getSectionText(S.section.id);
      const m = (text || '').match(/(?:^|\n)\s*(\d+\.\d+)\s/);
      S.prob.qno = m ? m[1] : '';
      const noEl = $('#probNo');
      if (noEl) noEl.value = S.prob.qno;
      toast(S.prob.qno ? ('已填入题号 ' + S.prob.qno) : '没自动识别到题号，请手填');
    },
    'run-prob-all': async () => {
      if (!S.section || !S.section.isProblems) return;
      const text = await getSectionText(S.section.id);
      await generate({
        task: 'probAll',
        ctx: { num: S.chapter ? S.chapter.num : '', title: S.chapter ? S.chapter.title : '', text: (text || '').slice(0, 30000) },
        outKey: 'probAll',
        extraTools: TOOL_EXTRA.probAll
      });
    },
    'run-prob-summary': async () => {
      if (!S.chapter) return toast('先选章节');
      const num = S.chapter.num, title = S.chapter.title;
      let text = '';
      try {
        const cf = await API.chapterFull(S.chapter.id);
        text = (cf && cf.text) || '';
      } catch (e) { /* fallback */ }
      if (!text) text = await getChapterContext(S.chapter.id, 45000);
      const baseCtx = { num, title, text };
      const specFull = '# 第' + num + '章 ' + title + ' · 知识点提纲\n\n' + OUTLINE_SPEC;
      if (text.length > MAPREDUCE_THRESHOLD) {
        toast('本章 ' + text.length + ' 字符：先分块提炼要点再合并，保证覆盖全章', 3000);
        await generate({
          task: 'chapterSummary', ctx: baseCtx, outKey: 'chSummary', extraTools: TOOL_EXTRA.chSummary,
          prep: (status) => packNotesPrep(num, title, text, specFull, status)
        });
      } else {
        await generate({ task: 'chapterSummary', ctx: baseCtx, outKey: 'chSummary', extraTools: TOOL_EXTRA.chSummary });
      }
    },

    'copy-out': (el) => { const k = el.dataset.key; copyText(S.outs[k] || '').then(() => toast('已复制')); },
    'stop-gen': () => { if (S.abort) S.abort.abort(); },
    'save-note': (el) => saveNoteAs(el.dataset.key, S.outs[el.dataset.key]),
    'pack-export': () => downloadFile('学习包-' + (S.chapter ? ('第' + S.chapter.num + '章') : '') + '-' + today() + '.md', S.outs.pack || '', 'text/markdown'),
    'pack-print': () => printText('学习包', S.outs.pack || ''),
    'cards-csv': () => {
      const csv = extractCsv(S.outs.cards || '');
      if (!csv) return toast('没有找到 CSV 代码块');
      downloadFile('术语卡-' + today() + '.csv', csv, 'text/csv');
    },
    'cards-import': () => {
      const csv = extractCsv(S.outs.cards || '');
      if (!csv) return toast('没有找到 CSV 代码块');
      const rows = parseCsv(csv);
      let n = 0;
      rows.forEach(r => {
        if (!r[0] || /^正面/.test(r[0])) return;
        wbAdd({ en: r[0], zh: r[1] || '', note: r[2] || '', cat: classifyTerm(r[0], r[2] || r[1] || ''), src: S.chapter ? ('第' + S.chapter.num + '章') : '', source: 'cards' });
        n++;
      });
      saveGlossary(); updateCounts();
      toast('已导入 ' + n + ' 条术语');
    },

    'plan-toggle': (el) => {
      S.plan[el.dataset.key] = el.checked;
      savePlan();
      // 更新样式
      const label = el.closest('.task');
      if (label) label.classList.toggle('done', el.checked);
    },
    'plan-cfg-save': () => {
      const start = (($('#planStart') || {}).value) || '';
      const deadline = (($('#planDeadline') || {}).value) || '';
      if (!start || !deadline) { toast('请填写开始和截止日期'); return; }
      if (new Date(deadline) <= new Date(start)) { toast('截止日期要晚于开始日期'); return; }
      S.planCfg = Object.assign({}, S.planCfg, {
        mode: 'auto', start, deadline,
        hours: parseFloat((($('#planHours') || {}).value)) || 3,
        chapters: ((($('#planChapters') || {}).value) || '1-9').trim() || '1-9'
      });
      savePlanCfg();
      showView('plan');
      toast('学习计划已更新');
    },
    'plan-cfg-preset': () => {
      S.planCfg = Object.assign({}, S.planCfg, { mode: 'preset' });
      savePlanCfg();
      showView('plan');
      toast('已载入内置 6 周计划');
    },
    'plan-add-task': () => {
      const wk = parseInt((($('#planWeekSel') || {}).value), 10) || 0;
      const txt = (((($('#planTaskInput') || {}).value) || '')).trim();
      if (!txt) { toast('先写任务内容'); return; }
      S.planCfg.custom = S.planCfg.custom || {};
      (S.planCfg.custom[wk] = S.planCfg.custom[wk] || []).push({ id: 'ct' + uid(), text: txt });
      savePlanCfg();
      showView('plan');
      toast('已添加自定义任务');
    },
    'plan-del-task': (el) => {
      const wk = parseInt(el.dataset.week, 10) || 0;
      const id = el.dataset.id;
      if (S.planCfg.custom && S.planCfg.custom[wk]) {
        S.planCfg.custom[wk] = S.planCfg.custom[wk].filter(t => t.id !== id);
        if (!S.planCfg.custom[wk].length) delete S.planCfg.custom[wk];
      }
      savePlanCfg();
      showView('plan');
    },

    'text-style-reset': () => {
      S.ui.textSize = 13.6;
      S.ui.textFont = 'default';
      S.ui.textLine = 1.85;
      saveUi();
      applyTextStyle();
      toast('已恢复原版字号 / 字体 / 行距');
    },
    'glossary-filter': (el) => { S.wbFilter = el.dataset.cat || 'all'; showView('glossary'); },
    'glossary-search': () => { S.wbQuery = ((($('#gSearch') || {}).value) || '').trim(); showView('glossary'); },
    'glossary-edit': (el) => {
      const id = el.dataset.id;
      const it = (S.glossary || []).find(g => g.id === id);
      if (!it) return;
      const v = window.prompt('修改「' + it.en + '」的解释 / 上下文：', it.note || '');
      if (v === null) return;
      it.note = String(v).trim();
      saveGlossary(); updateCounts(); showView('glossary');
      toast('已更新释义');
    },
    'glossary-add': () => {
      const en = (((($('#gEn') || {}).value) || '')).trim();
      const note = (((($('#gNote') || {}).value) || '')).trim();
      if (!en) { toast('单词 / 术语不能为空'); return; }
      const cat = ((($('#gCat') || {}).value) || '') || classifyTerm(en, note);
      wbAdd({ en, zh: '', note, cat, src: S.chapter ? ('第' + S.chapter.num + '章') : '', source: 'manual' });
      saveGlossary(); updateCounts(); showView('glossary');
      toast('已加入单词本');
    },
    'glossary-cat': (el) => {
      const id = el.dataset.id;
      const it = (S.glossary || []).find(g => g.id === id);
      if (it) { it.cat = el.value; saveGlossary(); updateCounts(); showView('glossary'); toast('分类已更新 · ' + wbCatName(it.cat)); }
    },
    'glossary-del': (el) => {
      const id = el.dataset.id;
      S.glossary = (S.glossary || []).filter(g => g.id !== id);
      saveGlossary(); updateCounts(); showView('glossary');
    },
    'glossary-clear': () => { if (confirm('确定清空单词本？')) { S.glossary = []; saveGlossary(); updateCounts(); showView('glossary'); } },
    'glossary-reclass': () => {
      const n = reclassifyWordbook();
      saveGlossary(); updateCounts(); showView('glossary');
      toast(n ? ('已重新自动分类 ' + n + ' 条') : '分类已是最新');
    },
    'glossary-resync': () => {
      const n = migrateLookupHistory(true);
      const m = reclassifyWordbook();
      saveGlossary(); updateCounts(); showView('glossary');
      toast('已同步历史查词' + (n ? ('，新增 ' + n + ' 条') : '') + (m ? ('，重新分类 ' + m + ' 条') : ''), 2600);
    },
    'glossary-export-csv': () => {
      const csv = '正面,背面,分类\n' + S.glossary.map(g =>
        csvCell(g.en + (g.src ? '（' + g.src + '）' : '')) + ',' +
        csvCell(g.note || '') + ',' + csvCell(wbCatName(g.cat))
      ).join('\n');
      downloadFile('单词本-' + today() + '.csv', csv, 'text/csv');
    },
    'glossary-export-md': () => {
      const mdTxt = '| 单词 / 术语 | 分类 | 解释 | 来源 |\n| --- | --- | --- | --- |\n' +
        S.glossary.map(g => '| ' + g.en + ' | ' + wbCatName(g.cat) + ' | ' + (g.note || '') + ' | ' + (g.src || '') + ' |').join('\n');
      downloadFile('单词本-' + today() + '.md', mdTxt, 'text/markdown');
    },

    'review-open': () => { S.rev = null; revState(); showView('review'); },
    'review-back': () => showView('glossary'),
    'review-start': () => revBuildQueue(),
    'review-answer': (el) => revAnswer(parseInt(el.dataset.i, 10)),
    'review-spell-submit': () => revSubmitSpell(),
    'review-rate': (el) => revRate(el.dataset.level),
    'review-next': () => revNext(),
    'review-retry-wrong': () => revRetryWrong(),
    'review-restart': () => { if (S.rev) { S.rev.phase = 'setup'; } showView('review'); },

    'mistakes-del': (el) => { S.mistakes.splice(Number(el.dataset.i), 1); saveMistakes(); updateCounts(); showView('mistakes'); },
    'mistakes-export': () => {
      const mdTxt = S.mistakes.map(m => '## ' + m.date + ' · ' + m.chapter + '\n\n**题目**\n\n' + m.question + '\n\n**我的解答**\n\n' + m.answer + '\n\n**批改要点**\n\n' + m.feedback + '\n').join('\n---\n\n');
      downloadFile('错题本-' + today() + '.md', mdTxt, 'text/markdown');
    },

    'quiz-generate': async () => {
      const chapters = learnedChaptersLabel();
      const mistakes = S.mistakes.slice(0, 8).map(m => '[' + m.chapter + '] ' + (m.feedback || '').slice(0, 300)).join('\n');
      S.quiz.q = ''; S.quiz.a = ''; S.quiz.fb = '';
      showView('quiz');
      await generate({
        task: 'quiz',
        ctx: { chapters, mistakes },
        outKey: 'quiz',
        targetId: 'quizOut',
        after: (t) => { S.quiz.q = t; showView('quiz'); }
      });
    },
    'quiz-from-mistakes': async () => {
      if (!S.mistakes.length) { toast('错题本还是空的'); return; }
      showView('quiz');
      ACTIONS['quiz-generate']();
    },
    'quiz-grade': async () => {
      const ta = $('#quizAnswers');
      S.quiz.a = ta ? ta.value : '';
      if (!S.quiz.q) return toast('先出题');
      await generate({
        task: 'grade',
        ctx: { questions: S.quiz.q, answers: S.quiz.a || '（未作答）' },
        outKey: 'quizFb2',
        targetId: 'quizFb',
        after: (t) => { S.quiz.fb = t; showView('quiz'); }
      });
    },
    'quiz-save-mistakes': () => {
      if (!S.quiz.q) return toast('还没有周测题');
      S.mistakes.unshift({
        id: uid(), date: nowStr(), chapter: '周测', source: '周测',
        question: S.quiz.q, answer: S.quiz.a || '', feedback: S.quiz.fb || '（未批改，仅记录）'
      });
      saveMistakes(); updateCounts();
      toast('已存入错题本');
    },

    'save-cfg': () => saveSettings(),
    'test-api': () => testApi(),
    'export-all': () => exportAll(),

    'archive-open': (el) => {
      const sid = el.dataset.id;
      const a = S.archive[sid] || {};
      showView('study');
      openSection(sid);
      if (a.pre || a.preAnswers) S.workTab = 'pre';
      else if (a.close || a.formula || a.cards) S.workTab = 'close';
      else if (a.practiceQ) S.workTab = 'practice';
      else if (a.feynmanQ || a.feynmanDiag) S.workTab = 'feynman';
      else if (a.pack) S.workTab = 'pack';
      renderWork();
    },
    'archive-del': (el) => {
      const sid = el.dataset.id;
      if (!confirm('删除这一节的全部存档？删除后无法恢复。')) return;
      delete S.archive[sid];
      store.set('archive', S.archive);
      showView('archive');
      toast('已删除该节存档');
    },
    'archive-export': () => {
      const ids = Object.keys(S.archive || {});
      if (!ids.length) return toast('还没有存档');
      const LAB = { pre: '读前预习', preAnswers: '读前问题解答', close: '四栏精读', formula: '公式拆解', cards: '术语卡', pack: '学习包', practiceQ: '练习题目', practiceFB: '批改', feynmanQ: '费曼提问', feynmanDiag: '费曼诊断' };
      let mdTxt = '# 电力电子学习台 · 学习存档\n\n导出时间：' + nowStr() + '\n\n';
      const nodes = ids.map(sid => ({ sid, f: findSection(sid), a: S.archive[sid] }))
        .filter(x => x.f && x.a)
        .sort((x, y) => (x.f.chapter.num - y.f.chapter.num) || String(x.f.section.num).localeCompare(String(y.f.section.num)));
      nodes.forEach(n => {
        mdTxt += '\n---\n\n## 第 ' + n.f.chapter.num + ' 章 · ' + n.f.section.num + ' ' + n.f.section.title + '\n\n';
        ARCH_KEYS.forEach(k => {
          if (!n.a[k]) return;
          mdTxt += '### ' + (LAB[k] || k) + '\n\n' + n.a[k] + '\n\n';
        });
        if (n.a.chat && n.a.chat.display && n.a.chat.display.length) {
          mdTxt += '### 追问\n\n';
          n.a.chat.display.forEach(m => { mdTxt += (m.role === 'user' ? '**问：** ' : '') + m.text + '\n\n'; });
        }
        if (n.a.qa && n.a.qa.display && n.a.qa.display.length) {
          mdTxt += '### 自由问答\n\n';
          n.a.qa.display.forEach(m => { mdTxt += (m.role === 'user' ? '**问：** ' : '') + m.text + '\n\n'; });
        }
      });
      downloadFile('学习存档-' + today() + '.md', mdTxt, 'text/markdown');
    },
    'use-model': (el) => {
      const v = el.dataset.v;
      const cfg = API.cfg();
      cfg.model = v;
      API.saveCfg(cfg);
      updateStatusPill();
      toast('已切换到模型 ' + v + '，正在重试…');
      const run = S.lastRun;
      S.lastRun = null;
      if (run) setTimeout(() => generate(run), 80);
    },
    'pick-model': (el) => {
      const m = $('#cfgModel');
      if (m) m.value = el.dataset.v;
      toast('已填入模型：' + el.dataset.v + '，记得点保存');
    }
  };

  function saveNoteAs(name, text) {
    if (!text) return toast('没有内容可保存');
    const key = (name || '笔记') + ' · ' + nowStr();
    S.notes[key] = text;
    store.set('notes', S.notes);
    toast('已存为笔记（共 ' + Object.keys(S.notes).length + ' 条，可在设置里导出）');
  }

  function printText(title, text) {
    const w = window.open('', '_blank');
    if (!w) return toast('浏览器拦截了弹窗');
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) +
      '</title><style>body{font:14px/1.8 "Microsoft YaHei",sans-serif;max-width:820px;margin:32px auto;padding:0 20px;color:#1b2430}' +
      'pre{background:#f5f7fa;padding:10px;border-radius:6px;overflow:auto}table{border-collapse:collapse;width:100%}' +
      'td,th{border:1px solid #ccc;padding:6px}code{background:#f0f3f8;padding:1px 4px}</style></head><body>' +
      '<div id="c"></div></body></html>');
    w.document.getElementById('c').innerHTML = md(text);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 400);
  }

  function extractCsv(text) {
    const m = /```csv\s*([\s\S]*?)```/i.exec(text || '');
    return m ? m[1].trim() : '';
  }

  function parseCsv(csv) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < csv.length; i++) {
      const c = csv[i];
      if (q) {
        if (c === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') { q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && csv[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(x => x.trim())) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some(x => x.trim())) rows.push(row);
    return rows;
  }

  function csvCell(s) {
    s = String(s == null ? '' : s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function updateCounts() {
    const g = $('#glossCount'), m = $('#missCount');
    if (g) g.textContent = S.glossary.length;
    if (m) m.textContent = S.mistakes.length;
  }

  /* ---------------------------------------------------------- event wiring */
  function bindEvents() {
    document.addEventListener('click', (e) => {
      const mark = e.target.closest && e.target.closest('mark.hl');
      if (mark) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;   // 正在选文字，不删除
        hideHlTip();
        removeHighlight(mark.getAttribute('data-hid'));
        return;
      }
      const el = e.target.closest('[data-act]');
      if (el) {
        const act = el.dataset.act;
        if (ACTIONS[act]) {
          // 复选框依赖默认行为切换状态，不能 preventDefault
          const isCheckbox = el.tagName === 'INPUT' && el.type === 'checkbox';
          if (!isCheckbox) e.preventDefault();
          try { ACTIONS[act](el); } catch (err) { console.error(err); toast('操作失败：' + err.message); }
        } else if (act === 'go-study') {
          showView('study');
        }
        return;
      }
      const viewBtn = e.target.closest('[data-view]');
      if (viewBtn) { showView(viewBtn.dataset.view); return; }
      if (e.target.closest('#btnSettings')) { openSettings(); return; }
      if (e.target.closest('#btnTheme')) { cycleTheme(); return; }
      if (e.target.closest('#btnBackupNow')) {
        doAutoBackup('manual').then(r => { if (r) toast('已备份到 backups/ 目录'); refreshBackupInfo(); });
        return;
      }
      if (e.target.closest('#btnPromptEditor')) { openPromptEditor(); return; }
      if (e.target.closest('#btnClosePrompt') || e.target.closest('#btnClosePrompt2')) { $('#promptModal').classList.add('hidden'); return; }
      if (e.target.closest('#btnPromptSave')) { savePromptTask(); return; }
      if (e.target.closest('#btnPromptResetOne')) { resetPromptTask($('#promptTaskSel').value); return; }
      if (e.target.closest('#btnPromptResetAll')) {
        S.customPrompts = {};
        PROMPTS.setCustom({});
        savePrompts();
        loadPromptTask($('#promptTaskSel').value);
        toast('全部提示词已恢复为内置预设');
        return;
      }
      if (e.target.closest('#btnFetchModels')) { fetchModels(); return; }
      if (e.target.closest('#btnCloseModal')) { $('#modal').classList.add('hidden'); return; }
      if (e.target.closest('#btnSaveCfg')) { saveSettings(); return; }
      if (e.target.closest('#btnTestApi')) { testApi(); return; }
      if (e.target.closest('#btnExportAll')) { exportAll(); return; }
      if (e.target.closest('#btnImportAll')) { $('#importFile').click(); return; }
      if (e.target.id === 'btnBack') { showView('study'); return; }
      if (e.target.closest('#modal')) { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); return; }
      const rt = e.target.closest('[data-rt]');
      if (rt) { setReaderTab(rt.dataset.rt); return; }
      const wt = e.target.closest('[data-wt]');
      if (wt) { S.workTab = wt.dataset.wt; renderWork(); return; }
      const sb = e.target.closest('[data-sel]');
      if (sb) { handleSelAction(sb.dataset.sel); return; }
      if (e.target.closest('#btnPrevPage')) { setPage(S.page - spreadStep()); return; }
      if (e.target.closest('#btnNextPage')) { setPage(S.page + spreadStep()); return; }
      if (e.target.closest('#btnToggleSide')) { toggleSide(); return; }
      if (e.target.closest('#btnToggleWork')) { toggleWork(); return; }
      if (e.target.closest('#btnToggleTop')) { toggleTop(); return; }
      if (e.target.closest('#btnShowTopbar')) { S.ui.showTop = true; saveUi(); applyUi(); return; }
      if (e.target.closest('#btnFullscreen')) { toggleFullscreen(); return; }
    });

    document.addEventListener('change', (e) => {
      if (e.target.id === 'revCat') { revState().cfg.cat = e.target.value; showView('review'); return; }
      if (e.target.id === 'revChapter') { revState().cfg.chapter = e.target.value; showView('review'); return; }
      if (e.target.id === 'revMode') { revState().cfg.mode = e.target.value; showView('review'); return; }
      if (e.target.id === 'revLimit') { revState().cfg.limit = parseInt(e.target.value, 10) || 20; showView('review'); return; }
      if (e.target.id === 'revQuizType') { revState().cfg.quizType = e.target.value; showView('review'); return; }
      if (e.target.matches('.cat-select[data-id]')) { ACTIONS['glossary-cat'](e.target); return; }
      if (e.target.id === 'gSearch') { S.wbQuery = (e.target.value || '').trim(); showView('glossary'); return; }
      if (e.target.id === 'qaUseText') { S.qa.useText = !!e.target.checked; saveQaArchive(); return; }
      if (e.target.id === 'qaUseChapter') { S.qa.useChapter = !!e.target.checked; saveQaArchive(); return; }
      if (e.target.id === 'cfgTheme') { S.ui.theme = e.target.value || 'light'; saveUi(); applyTheme(); return; }
      if (e.target.id === 'promptTaskSel') { loadPromptTask(e.target.value); return; }
      if (e.target.id === 'cfgAutoBackup') {
        S.ui.autoBackup = !!e.target.checked;
        saveUi();
        if (S.ui.autoBackup) scheduleAutoBackup();
        return;
      }
      if (e.target.id === 'sectionSelect') { openSection(e.target.value); return; }
      if (e.target.id === 'probNo') { S.prob.qno = e.target.value.trim(); return; }
      if (e.target.id === 'probQ') { S.prob.question = e.target.value; return; }
      if (e.target.id === 'dpiSelect') { S.dpi = parseInt(e.target.value, 10) || 120; renderPageImage(); return; }
      if (e.target.id === 'spreadSelect') {
        S.ui.spread = e.target.value;
        if (S.ui.spread === 'double') {
          autoWidenForDouble();
        } else {
          restoreReaderWidth();
        }
        saveUi();
        renderPageImage();
        return;
      }

      if (e.target.id === 'textSizeSelect') {
        S.ui.textSize = parseFloat(e.target.value) || 13.6;
        saveUi();
        applyTextStyle();
        return;
      }
      if (e.target.id === 'textFontSelect') {
        S.ui.textFont = e.target.value || 'default';
        saveUi();
        applyTextStyle();
        return;
      }
      if (e.target.id === 'textLineSelect') {
        S.ui.textLine = parseFloat(e.target.value) || 1.85;
        saveUi();
        applyTextStyle();
        return;
      }
      if (e.target.id === 'imgScaleSelect') {
        S.ui.imgScale = parseFloat(e.target.value) || 0.5;
        saveUi();
        $$('#textPane .fig-block img[data-w]').forEach(img => {
          const w = parseFloat(img.getAttribute('data-w'));
          if (w) img.style.width = Math.round(w * (170 / 72) * S.ui.imgScale) + 'px';
        });
        return;
      }
      if (e.target.id === 'pageInput') { setPage(parseInt(e.target.value, 10) || 1); return; }
      if (e.target.id === 'cfgProvider') { applyProviderPreset(); return; }
      if (e.target.id === 'importFile' && e.target.files && e.target.files[0]) { importAll(e.target.files[0]); return; }
    });

    $('#pageInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { setPage(parseInt(e.target.value, 10) || 1); e.target.blur(); }
    });

    document.addEventListener('keydown', (e) => {
      const tag = (document.activeElement || {}).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ($('#pageView').classList.contains('hidden') === false) return;
      if (e.key === 'ArrowLeft') { setPage(S.page - spreadStep()); }
      if (e.key === 'ArrowRight') { setPage(S.page + spreadStep()); }
    });

    document.addEventListener('mousemove', (e) => {
      const mark = e.target.closest && e.target.closest('mark.hl');
      if (mark) showHlTip(mark, e.clientX, e.clientY);
      else hideHlTip();
    });

    document.addEventListener('input', (e) => {
      const id = e.target && e.target.id;
      if (id !== 'closeInput' && id !== 'formulaInput' && id !== 'cardsInput') return;
      clearTimeout(draftSaveTimer);
      draftSaveTimer = setTimeout(() => {
        const c = $('#closeInput'), f = $('#formulaInput'), k = $('#cardsInput');
        if (c) S.drafts.close = c.value;
        if (f) S.drafts.formula = f.value;
        if (k) S.drafts.cards = k.value;
        saveArchive({ drafts: S.drafts });
      }, 800);
    });

    document.addEventListener('keydown', (e) => {
      if (!S.rev || S.rev.phase !== 'quiz') return;
      if (e.target && e.target.matches && e.target.matches('textarea,select')) return;
      if (e.target && e.target.id === 'revInput') {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (S.rev.answered) ACTIONS['review-next'](); else ACTIONS['review-spell-submit']();
        }
        return;
      }
      if (S.rev.answered) {
        if (e.key === 'Enter') { ACTIONS['review-next'](); return; }
        if (!S.rev.rated && /^[1-3]$/.test(e.key)) {
          ACTIONS['review-rate']({ dataset: { level: ['again', 'hard', 'good'][Number(e.key) - 1] } });
        }
        return;
      }
      const q = S.rev.queue && S.rev.queue[S.rev.idx];
      if (q && q.type === 'choice' && /^[1-4]$/.test(e.key)) {
        ACTIONS['review-answer']({ dataset: { i: String(Number(e.key) - 1) } });
      } else if (q && q.type === 'spell' && e.key === 'Enter') {
        ACTIONS['review-spell-submit']();
      }
    });
    document.addEventListener('fullscreenchange', syncFullscreenBtn);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideTermPop();
        hideHlPop();
        hideSelBar();
        const modal = $('#modal');
        if (modal && !modal.classList.contains('hidden')) modal.classList.add('hidden');
      }
    });
  }

  /* ---------------------------------------------------------- 布局：折叠 / 拖拽 / 单双页 */
  function saveUi() {
    store.set('ui', S.ui);
  }


  function applyTextStyle() {
    if (!store.get('textStyleV2', false)) {
      S.ui.textSize = 13.6;
      S.ui.textFont = 'default';
      S.ui.textLine = 1.85;
      store.set('textStyleV2', true);
      saveUi();
    }
    const pane = $('#textPane');
    if (!pane) return;
    const fonts = {
      'default': '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      'serif': 'Georgia, "Times New Roman", "SimSun", serif',
      'sans': '"Microsoft YaHei", "PingFang SC", Arial, sans-serif',
      'kai': '"KaiTi", "STKaiti", "Kaiti SC", serif',
      'mono': 'Consolas, "Cascadia Mono", "Courier New", monospace'
    };
    const size = Number(S.ui.textSize) || 13.6;
    const line = Number(S.ui.textLine) || 1.85;
    const font = fonts[S.ui.textFont] || fonts['default'];
    pane.style.setProperty('--tp-size', size + 'px');
    pane.style.setProperty('--tp-line', String(line));
    pane.style.setProperty('--tp-font', font);
    const ts = $('#textSizeSelect');
    if (ts) ts.value = String(size);
    const tf = $('#textFontSelect');
    if (tf) tf.value = S.ui.textFont || 'default';
    const tl = $('#textLineSelect');
    if (tl) tl.value = String(line);
  }


  function applyTheme() {
    const order = ['light', 'eye', 'dark'];
    const theme = order.indexOf(S.ui.theme) >= 0 ? S.ui.theme : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    const btn = $('#btnTheme');
    if (btn) {
      btn.textContent = theme === 'dark' ? '🌙 夜间' : (theme === 'eye' ? '🌤 护眼' : '☀️ 浅色');
      btn.title = '当前：' + (theme === 'dark' ? '夜间' : (theme === 'eye' ? '护眼' : '浅色')) + '；点击切换';
    }
    const sel = $('#cfgTheme');
    if (sel) sel.value = theme;
  }

  function cycleTheme() {
    const order = ['light', 'eye', 'dark'];
    const cur = order.indexOf(S.ui.theme) >= 0 ? order.indexOf(S.ui.theme) : 0;
    S.ui.theme = order[(cur + 1) % 3];
    saveUi();
    applyTheme();
    toast('已切换为' + (S.ui.theme === 'dark' ? '夜间' : (S.ui.theme === 'eye' ? '护眼' : '浅色')) + '模式');
  }

  function applyUi() {
    const ui = S.ui;
    const side = $('#sidebar');
    if (side) side.style.width = (ui.sideW || 264) + 'px';
    const reader = $('#reader');
    if (reader) {
      if (ui.readerW && ui.readerW > 0) reader.style.width = ui.readerW + 'px';
      else reader.style.width = '';
    }
    document.body.classList.toggle('hide-sidebar', !ui.showSide);
    document.body.classList.toggle('hide-work', !ui.showWork);
    document.body.classList.toggle('hide-topbar', !ui.showTop);
    $$('#btnToggleSide').forEach(b => b.classList.toggle('on', !!ui.showSide));
    $$('#btnToggleWork').forEach(b => b.classList.toggle('on', !!ui.showWork));
    const ft = $('#btnShowTopbar');
    if (ft) ft.classList.toggle('hidden', !!ui.showTop);
    const sp = $('#spreadSelect');
    if (sp) sp.value = ui.spread === 'double' ? 'double' : 'single';
    const ims = $('#imgScaleSelect');
    if (ims) ims.value = String(ui.imgScale || 0.5);
    applyTextStyle();
    applyTheme();
  }

  function toggleTop() {
    S.ui.showTop = !S.ui.showTop;
    saveUi();
    applyUi();
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      const el = document.documentElement;
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => toast('浏览器拒绝了全屏请求，可用 F11'));
      } else {
        toast('当前浏览器不支持全屏 API，可用 F11');
      }
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }

  function syncFullscreenBtn() {
    const btn = $('#btnFullscreen');
    if (btn) btn.textContent = document.fullscreenElement ? '⛶ 退出全屏' : '⛶ 全屏';
  }

  function autoWidenForDouble() {
    if (!S.ui.showWork) return;
    const sv = $('#studyView');
    const reader = $('#reader');
    if (!sv || !reader) return;
    const total = sv.getBoundingClientRect().width;
    const cur = reader.getBoundingClientRect().width;
    const target = Math.min(total - 320, Math.max(cur, 780));
    if (target > cur + 10) {
      S.ui._prevW = S.ui.readerW || Math.round(cur);
      S.ui._autoWidened = true;
      S.ui.readerW = Math.round(target);
      reader.style.width = S.ui.readerW + 'px';
      toast('已自动加宽教材区（可拖动分隔条微调）');
    }
  }

  function restoreReaderWidth() {
    if (!S.ui._autoWidened) return;
    S.ui._autoWidened = false;
    S.ui.readerW = S.ui._prevW || 0;
    S.ui._prevW = null;
    const reader = $('#reader');
    if (reader) reader.style.width = S.ui.readerW ? S.ui.readerW + 'px' : '';
  }

  function toggleSide() {
    S.ui.showSide = !S.ui.showSide;
    saveUi();
    applyUi();
  }

  function toggleWork() {
    S.ui.showWork = !S.ui.showWork;
    saveUi();
    applyUi();
  }

  function bindSplitters() {
    const side = $('#splitSide');
    const rd = $('#splitReader');
    const drag = (el, onMove, onEnd, onReset) => {
      if (!el) return;
      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        el.classList.add('active');
        document.body.classList.add('dragging');
        const move = (e2) => onMove(e2.clientX);
        const up = () => {
          el.classList.remove('active');
          document.body.classList.remove('dragging');
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('lostpointercapture', up);
          if (onEnd) onEnd();
        };
        el.setPointerCapture(ev.pointerId);
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('lostpointercapture', up);
      });
      el.addEventListener('dblclick', () => {
        if (onReset) onReset();
        saveUi(); applyUi();
      });
    };
    drag(side, (x) => {
      S.ui.sideW = Math.max(180, Math.min(520, x));
      const s = $('#sidebar');
      if (s) s.style.width = S.ui.sideW + 'px';
    }, () => saveUi(), () => { S.ui.sideW = 264; });
    drag(rd, (x) => {
      const sv = $('#studyView');
      if (!sv) return;
      const left = sv.getBoundingClientRect().left;
      const w = Math.max(280, Math.min(sv.getBoundingClientRect().width - 320, x - left));
      S.ui.readerW = Math.round(w);
      S.ui._autoWidened = false;
      const r = $('#reader');
      if (r) r.style.width = S.ui.readerW + 'px';
    }, () => saveUi(), () => { S.ui.readerW = 0; S.ui._autoWidened = false; });
  }

  async function handleSelAction(kind) {
    const text = S.selectedText;
    if (!text) return;
    hideSelBar();
    if (kind === 'hl') {
      openHlPop();
      return;
    }
    if (kind === 'close') {
      S.closeTab = 'four'; S.drafts.close = text;
      S.workTab = 'close'; renderWork();
      const ta = $('#closeInput'); if (ta) ta.value = text;
      ACTIONS['run-close']();
    } else if (kind === 'formula') {
      S.closeTab = 'formula'; S.drafts.formula = text;
      S.workTab = 'close'; renderWork();
      const ta = $('#formulaInput'); if (ta) ta.value = text;
      ACTIONS['run-formula']();
    } else if (kind === 'cards') {
      if (isShortTerm(text)) { quickTerm(); return; }
      S.closeTab = 'cards'; S.drafts.cards = text;
      S.workTab = 'close'; renderWork();
      const ta = $('#cardsInput'); if (ta) ta.value = text;
      ACTIONS['run-cards']();
    } else if (kind === 'ask') {
      S.closeTab = 'ask'; S.workTab = 'close'; renderWork();
      const ta = $('#askInput');
      if (ta) { ta.value = '请解释这段原文：' + text.slice(0, 200); ta.focus(); }
    }
  }

  /* ---------------------------------------------------------- init */
  async function init() {
    PROMPTS.setCustom(S.customPrompts || {});
    if (window.marked && window.marked.setOptions) {
      window.marked.setOptions({ gfm: true, breaks: true });
    }
    updateStatusPill();
    updateCounts();
    bindEvents();
    setupSelection();
    applyUi();
    bindSplitters();

    try {
      await loadBook();
      normalizeGlossary();
      migrateLookupHistory();
      ensureWordbookV2();
    } catch (e) {
      $('#workBody').innerHTML = '<div class="card"><div class="card-title">教材数据未就绪</div>' +
        '<div class="tiny">首次使用：把你自己合法获得的教材 PDF 放到项目根目录并命名为 <code>book.pdf</code>（或复制 <code>config.example.json</code> 为 <code>config.json</code> 填写路径），然后运行 <code>python tools/build_book.py</code>，再刷新本页。</div>' +
        '<div class="tiny muted">' + esc(e.message) + '</div></div>';
      return;
    }

    const last = store.get('lastSection', null);
    const found = last ? findSection(last) : null;
    if (found) { openSection(last); }
    else {
      const ch2 = findChapter('ch2') || S.chapters[0];
      if (ch2) openChapter(ch2.id);
    }
    setReaderTab('page');
    renderToc();
    if (!S.outs.pre) renderWork();

    // 启动时如距上次自动备份超过 12 小时，补一次
    if (S.ui.autoBackup !== false) {
      const last = store.get('lastAutoBackup', null);
      let stale = true;
      if (last && last.at) {
        const t = Date.parse(String(last.at).replace(' ', 'T'));
        if (!isNaN(t)) stale = (Date.now() - t) > 12 * 3600 * 1000;
      }
      if (stale) setTimeout(() => doAutoBackup('startup'), 4000);
    }
  }

  /* ---------------------------------------------------------- expose */
  window.APP = {
    state: S,
    openChapter, openSection, setPage, setReaderTab, showView,
    targetChapters, learnedChapters, learnedChaptersLabel, chapterStats, findSection,
    isChapterDone,
    markStage, renderToc, updateProgressBox, savePlan,
    generate, PROMPTS,
    collectData, doAutoBackup, refreshBackupInfo, openPromptEditor,
    textHash, resolveHighlights,
    notes: () => S.notes,
    reviewStreak: wbStreak, reviewDays: wbReviewDaysGet
  };

  document.addEventListener('DOMContentLoaded', init);
})();
