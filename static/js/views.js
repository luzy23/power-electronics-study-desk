/* ============================================================
 * views.js — 独立页面视图：学习计划 / 术语本 / 错题本 / 周测
 * 只负责生成 HTML 字符串；交互逻辑在 app.js 的 data-act 处理器里
 * ============================================================ */
(function (global) {
  'use strict';

  const PLAN = [
    {
      id: 'w1', title: '第 1 周', range: '10/20 – 10/26',
      goal: '第 1–2 章：引言 + 稳态分析方法',
      tasks: [
        { id: 'w1a', t: 'Ch.1 引言：快速通读，建立"功率处理 / 变换器 / 应用"框架（半天）' },
        { id: 'w1b', t: 'Ch.2：伏秒平衡、电荷平衡、小纹波近似（本章是全书的语法）' },
        { id: 'w1c', t: '产出：手推 Buck / Boost / Buck–Boost 的 M(D)，并用 LTspice 各仿真一次' },
        { id: 'w1d', t: '术语本录入 25–30 个核心术语' }
      ]
    },
    {
      id: 'w2', title: '第 2 周', range: '10/27 – 11/2',
      goal: '第 3–4 章：等效电路建模 + 开关实现',
      tasks: [
        { id: 'w2a', t: 'Ch.3：直流变压器模型、损耗与效率，学会画含损耗的等效电路' },
        { id: 'w2b', t: 'Ch.4：开关实现、功率半导体器件、开关损耗估算' },
        { id: 'w2c', t: '产出：给 Boost 加铜损 R_L，推导效率表达式并仿真验证' },
        { id: 'w2d', t: '完成第 3、4 章练习各 3 题' }
      ]
    },
    {
      id: 'w3', title: '第 3 周', range: '11/3 – 11/9',
      goal: '第 5–6 章：DCM + 变换器电路',
      tasks: [
        { id: 'w3a', t: 'Ch.5：DCM 的由来、模式边界与 M(D, K) 推导' },
        { id: 'w3b', t: 'Ch.6：拓扑演化、隔离型变换器（正激/反激/桥式）' },
        { id: 'w3c', t: '产出：一张"拓扑—应用—优缺点"对照表' },
        { id: 'w3d', t: '完成 Part I 阶段自测（用本工具「练习」功能）' }
      ]
    },
    {
      id: 'w4', title: '第 4 周', range: '11/10 – 11/16',
      goal: '★ 第 7 章：交流小信号建模（全书分水岭）',
      tasks: [
        { id: 'w4a', t: 'Ch.7：平均开关模型、状态空间平均、规范电路模型' },
        { id: 'w4b', t: '产出：手推 Buck 与 Boost 的小信号模型，与仿真 AC 扫描对照' },
        { id: 'w4c', t: '如果《自动控制原理》没学过：补 Bode 图、反馈、相位裕度（2 天）' },
        { id: 'w4d', t: '做完本章 5 道课后题（优先设计类）' }
      ]
    },
    {
      id: 'w5', title: '第 5 周', range: '11/17 – 11/23',
      goal: '第 8 章：传递函数与 Bode 图',
      tasks: [
        { id: 'w5a', t: 'Ch.8：变换器传递函数、零极点、阻抗图形化构建' },
        { id: 'w5b', t: '产出：画出 Buck 的 Gvd、输出阻抗、输入阻抗 Bode 图并解释每个零极点' },
        { id: 'w5c', t: '用 Python 脚本复现 Bode 图，与手算对照' }
      ]
    },
    {
      id: 'w6', title: '第 6 周', range: '11/24 – 11/30',
      goal: '第 9 章：控制器设计 + 总复习',
      tasks: [
        { id: 'w6a', t: 'Ch.9：环路增益、稳定性、补偿器设计、相位裕度' },
        { id: 'w6b', t: '产出：给 Buck 设计一个 Type-II 补偿器，仿真验证相位裕度 ≥ 45°' },
        { id: 'w6c', t: '总复习：用「学习包」把 9 章各生成一份，串成知识地图' },
        { id: 'w6d', t: '给导师写一页学习汇报（本工具「导出」功能可用）' }
      ]
    }
  ];

  function pDate(s, fallback) {
    if (!s) return fallback;
    const d = new Date(String(s) + 'T00:00:00');
    return isNaN(d.getTime()) ? fallback : d;
  }
  function pYmd(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function pMd(d) { return (d.getMonth() + 1) + '/' + d.getDate(); }

  function planCfg() {
    const S = global.APP.state;
    return Object.assign({
      mode: 'auto', start: '', deadline: '', hours: 3, chapters: '1-9', custom: {}
    }, S.planCfg || {});
  }

  function parsePlanChapters(spec) {
    const all = global.APP.targetChapters();
    const set = new Set();
    String(spec || '').split(/[,，\s]+/).forEach(tok => {
      const m = tok.match(/^(\d+)\s*[-–~]\s*(\d+)$/);
      if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
      } else if (/^\d+$/.test(tok)) {
        set.add(parseInt(tok, 10));
      }
    });
    const picked = all.filter(c => set.has(Number(c.num)));
    return picked.length ? picked : all;
  }

  /** 按日期 + 章节字数把章节分配到各周 */
  function buildAutoWeeks() {
    const cfg = planCfg();
    const start = pDate(cfg.start, (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })());
    const deadline = pDate(cfg.deadline, new Date(start.getTime() + 42 * 864e5));
    const days = Math.max(7, Math.ceil((deadline - start) / 864e5));
    const weeksN = Math.max(2, Math.min(26, Math.round(days / 7)));
    const chapters = parsePlanChapters(cfg.chapters);
    const weights = chapters.map(c => Math.max(1, (c.sections || []).reduce((a, s) => a + (s.chars || 0), 0)));
    const totalW = weights.reduce((a, b) => a + b, 0) || 1;
    const target = totalW / weeksN;
    const buckets = [];
    let cur = { chs: [], w: 0 };
    chapters.forEach((c, i) => {
      cur.chs.push(c);
      cur.w += weights[i];
      if ((cur.w >= target && buckets.length < weeksN - 1) || i === chapters.length - 1) {
        buckets.push(cur);
        cur = { chs: [], w: 0 };
      }
    });
    if (cur.chs.length) buckets.push(cur);
    while (buckets.length < weeksN) buckets.push({ chs: [], w: 0 });
    return buckets.slice(0, Math.max(weeksN, buckets.length)).map((b, i) => {
      const d1 = new Date(start.getTime() + i * 7 * 864e5);
      const d2 = new Date(d1.getTime() + 6 * 864e5);
      const nums = b.chs.map(c => c.num);
      const range = nums.length ? ('第 ' + nums[0] + (nums.length > 1 ? '–' + nums[nums.length - 1] : '') + ' 章') : '机动 / 补漏';
      const tasks = [];
      if (b.chs.length) {
        tasks.push({ id: 'w' + (i + 1) + 'a', t: range + '：通读 + 精读（' + b.chs.map(c => 'Ch.' + c.num).join('、') + '）' });
        tasks.push({ id: 'w' + (i + 1) + 'b', t: '产出：手推本章核心公式 / 画知识地图，再用「章节提纲」或「学习包」整理一遍' });
        tasks.push({ id: 'w' + (i + 1) + 'c', t: '练习：做课后题 3–5 道（用「习题」页），错题进错题本' });
        tasks.push({ id: 'w' + (i + 1) + 'd', t: '复盘：费曼法讲一遍本章主线；术语本录入 10–20 条' });
      } else {
        tasks.push({ id: 'w' + (i + 1) + 'a', t: '机动周：补前面没弄懂的内容，或做整册自测 / 总复习' });
      }
      return {
        title: '第 ' + (i + 1) + ' 周',
        range: pMd(d1) + ' – ' + pMd(d2),
        goal: range,
        tasks: tasks
      };
    });
  }

  function plan() {
    const S = global.APP.state;
    const done = S.plan || {};
    const cfg = planCfg();
    const preset = cfg.mode === 'preset';
    const weeks = preset
      ? global.VIEWS_PLAN_PRESET.map(w => ({ title: w.title, range: w.range, goal: w.goal, tasks: w.tasks }))
      : buildAutoWeeks();
    const start = pDate(cfg.start, new Date());
    const nowWeek = Math.max(0, Math.min(weeks.length - 1, Math.floor((new Date() - start) / (7 * 864e5))));

    let h = '<div class="card"><div class="card-title">自定义学习计划 <span class="tag">按日期 + 章节自动分周，可加自定义任务</span></div>' +
      '<div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">' +
      '<label class="tiny muted">开始日期<br><input class="input" type="date" id="planStart" value="' + pYmd(pDate(cfg.start, new Date())) + '"></label>' +
      '<label class="tiny muted">截止日期<br><input class="input" type="date" id="planDeadline" value="' + pYmd(pDate(cfg.deadline, new Date(Date.now() + 42 * 864e5))) + '"></label>' +
      '<label class="tiny muted">目标章节<br><input class="input" id="planChapters" value="' + global.U.esc(cfg.chapters || '1-9') + '" placeholder="如 1-9 或 1,3,5" style="width:130px"></label>' +
      '<label class="tiny muted">每天小时<br><input class="input" id="planHours" type="number" min="0.5" max="16" step="0.5" value="' + (cfg.hours || 3) + '" style="width:90px"></label>' +
      '<button class="btn primary" data-act="plan-cfg-save">保存并生成</button>' +
      '<button class="btn" data-act="plan-cfg-preset">' + (preset ? '当前：内置 6 周计划' : '载入内置 6 周计划') + '</button>' +
      '</div>' +
      '<div class="tiny muted" style="margin-top:6px">当前：' + (preset ? '内置 6 周计划（针对第 1–9 章的精读节奏）' : '自动计划（按截止日期与各章字数分配；越长的章给越多周）') + '。勾选与自定义任务会保存在本机。</div></div>';

    h += '<div class="row" style="margin-bottom:10px"><b style="font-size:13.5px">任务清单</b>' +
      '<span class="tiny muted">勾选会保存在本机</span></div>';

    weeks.forEach((w, i) => {
      const customs = (cfg.custom && cfg.custom[i]) || [];
      const allTasks = w.tasks.concat(customs.map(t => ({ id: t.id, t: t.text })));
      const allDone = allTasks.length && allTasks.every(t => done[t.id]);
      h += '<div class="week-card' + (i === nowWeek ? ' now' : '') + '">' +
        '<div class="week-head"><b>' + w.title + '</b><span class="range">' + w.range + '</span>' +
        '<span class="tiny muted">' + global.U.esc(w.goal) + '</span>' +
        (allDone ? '<span class="pill pill-ok" style="background:#e6f4f1;color:#0b6b4f;border-color:#bfe6dc">已完成</span>' : '') +
        '</div><div class="week-body">';
      allTasks.forEach(t => {
        h += '<label class="task' + (done[t.id] ? ' done' : '') + '">' +
          '<input type="checkbox" data-act="plan-toggle" data-key="' + t.id + '"' + (done[t.id] ? ' checked' : '') + '>' +
          '<span>' + global.U.esc(t.t) + '</span></label>';
      });
      // 删除自定义任务按钮（附在该周最后）
      if (customs.length) {
        h += '<div class="tiny muted" style="margin-top:4px">自定义任务：';
        customs.forEach(t => {
          h += '<span style="margin-right:6px">' + global.U.esc(t.text.slice(0, 20)) +
            ' <button class="link" data-act="plan-del-task" data-week="' + i + '" data-id="' + t.id + '">删除</button></span>';
        });
        h += '</div>';
      }
      h += '</div></div>';
    });

    // 添加自定义任务
    h += '<div class="card" style="margin-top:12px"><div class="card-title">添加自定义任务</div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      '<select id="planWeekSel" class="input" style="max-width:160px">' +
      weeks.map((w, i) => '<option value="' + i + '">第 ' + (i + 1) + ' 周</option>').join('') + '</select>' +
      '<input class="input" id="planTaskInput" placeholder="例如：把第 2 章课后题全部做一遍" style="flex:1;min-width:240px">' +
      '<button class="btn primary" data-act="plan-add-task">添加</button></div>' +
      '<div class="tiny muted">自定义任务会追加到所选周，可随时删除；建议每周不超过 6 条。</div></div>';

    // 章节进度
    const chapters = global.APP.targetChapters();
    h += '<div class="row" style="margin:18px 0 10px"><b style="font-size:13.5px">章节进度</b>' +
      '<span class="tiny muted">自动按小节进度计算；也可在左侧目录点 ○ / ✓ 手动标记「已学完」</span></div>' +
      '<div class="chapter-status">';
    chapters.forEach(ch => {
      const st = global.APP.chapterStats(ch);
      const manual = !!(global.APP.state.done && global.APP.state.done[ch.id]);
      const isDone = global.APP.isChapterDone(ch);
      h += '<div class="ch-stat' + (isDone ? ' ch-done' : '') + '"><b>第 ' + ch.num + ' 章' +
        (isDone ? ' <span class="ch-badge">✓ 已学完' + (manual ? '（手动）' : '') + '</span>' : '') + '</b>' +
        '<span class="tiny muted">' + global.U.esc(ch.title) + '</span>' +
        '<div class="bar"><i style="width:' + Math.round(st.pct * 100) + '%"></i></div>' +
        '<span class="tiny muted">' + Math.round(st.pct * 100) + '% · ' + st.done + '/' + st.total + ' 节</span></div>';
    });
    h += '</div>';

    h += '<div class="card" style="margin-top:16px"><div class="card-title">每周复盘模板</div>' +
      '<div class="tiny muted">每周日 20 分钟，回答三问：① 这周哪个公式我没法不看书画出来？② 哪个假设我讲不出失效后果？③ 下周要补哪一节？把答案写进「笔记」，再让导师看一眼。</div></div>';
    return h;
  }

  function glossary() {
    const S = global.APP.state;
    const items = S.glossary || [];
    let h = '<div class="card"><div class="card-title">新增术语</div><div class="row">' +
      '<input class="input" id="gEn" placeholder="英文术语，如 small-ripple approximation" style="flex:2;min-width:220px">' +
      '<input class="input" id="gZh" placeholder="中文译名" style="flex:1;min-width:130px">' +
      '<input class="input" id="gNote" placeholder="一句话解释 / 易混点" style="flex:2;min-width:200px">' +
      '<button class="btn primary" data-act="glossary-add">添加</button></div>' +
      '<div class="toolbar"><button class="btn" data-act="glossary-export-csv">导出 Anki CSV</button>' +
      '<button class="btn" data-act="glossary-export-md">导出 Markdown</button>' +
      '<button class="btn ghost" data-act="glossary-clear">清空</button>' +
      '<span class="tiny muted">共 ' + items.length + ' 条 · 精读「术语卡」生成后可直接导入</span></div></div>';

    if (!items.length) {
      h += '<div class="empty-state"><div class="big">📒</div>还没有术语。到「精读 → 术语卡」生成后点「导入术语本」，或在上方手动添加。</div>';
      return h;
    }
    h += '<table class="gtable"><thead><tr><th style="width:26%">英文</th><th style="width:20%">中文</th><th>解释 / 易混点</th><th style="width:90px">来源</th><th style="width:50px"></th></tr></thead><tbody>';
    items.forEach((g, i) => {
      h += '<tr><td class="en">' + global.U.esc(g.en) + '</td><td>' + global.U.esc(g.zh) + '</td><td>' +
        global.U.esc(g.note) + '</td><td class="tiny muted">' + global.U.esc(g.src || '') + '</td>' +
        '<td><button class="btn tiny-btn ghost" data-act="glossary-del" data-i="' + i + '">删</button></td></tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  function mistakes() {
    const S = global.APP.state;
    const items = S.mistakes || [];
    let h = '<div class="card"><div class="card-title">错题本 <span class="tag">周测会优先覆盖这些点</span></div>' +
      '<div class="toolbar"><button class="btn primary" data-act="quiz-from-mistakes">用错题生成周测</button>' +
      '<button class="btn" data-act="mistakes-export">导出 Markdown</button>' +
      '<span class="tiny muted">共 ' + items.length + ' 条</span></div></div>';
    if (!items.length) {
      h += '<div class="empty-state"><div class="big">✅</div>还没有错题。到「练习」做题并提交批改后，点「存入错题本」。</div>';
      return h;
    }
    items.forEach((m, i) => {
      h += '<div class="mistake-card"><div class="meta"><span>' + global.U.esc(m.date) + '</span>' +
        '<span>' + global.U.esc(m.chapter || '') + '</span>' +
        '<span class="tiny">' + (m.source || '') + '</span></div>' +
        '<div class="tiny" style="font-weight:600;margin-bottom:4px">题目</div><pre>' + global.U.esc(m.question) + '</pre>' +
        '<div class="tiny" style="font-weight:600;margin:4px 0">我的解答</div><pre>' + global.U.esc(m.answer || '') + '</pre>' +
        '<div class="tiny" style="font-weight:600;margin:4px 0">批改要点</div><pre>' + global.U.esc(m.feedback || '') + '</pre>' +
        '<div class="toolbar"><button class="btn tiny-btn ghost" data-act="mistakes-del" data-i="' + i + '">删除</button></div></div>';
    });
    return h;
  }

  function quiz() {
    const S = global.APP.state;
    const q = S.quiz || {};
    let h = '<div class="card"><div class="card-title">周测 <span class="tag">根据已学章节 + 错题本生成</span></div>' +
      '<div class="tiny muted" style="margin-bottom:8px">建议每周日做一次：先独立做，再提交批改；错题会自动进入错题本，下周周测会再次覆盖。</div>' +
      '<div class="toolbar"><button class="btn primary" data-act="quiz-generate">生成本周周测</button>' +
      '<span class="tiny muted">已学：' + global.U.esc(global.APP.learnedChaptersLabel()) + '</span></div></div>';

    h += '<div class="out' + (q.q ? '' : ' empty') + '" id="quizOut">' + (q.q ? '' : '点击上方按钮生成 10 道题') + '</div>';
    h += '<div class="toolbar" id="tools-quiz"></div>';

    if (q.q) {
      h += '<div class="card mt12"><div class="card-title">我的解答</div>' +
        '<textarea class="textarea" id="quizAnswers" style="min-height:160px" placeholder="按题号写答案；不会的写思路也行">' +
        global.U.esc(q.a || '') + '</textarea>' +
        '<div class="toolbar"><button class="btn primary" data-act="quiz-grade">提交批改</button>' +
        '<button class="btn" data-act="quiz-save-mistakes">存入错题本</button></div></div>';
    }
    h += '<div class="card' + (q.fb ? '' : ' hidden') + '"><div class="card-title">批改结果</div>' +
      '<div class="md" id="quizFb"></div></div>';
    return h;
  }

  const ARCH_LAB = {
    pre: '预习', preAnswers: '解答', close: '精读', formula: '公式', cards: '术语卡',
    pack: '学习包', practiceQ: '练习', practiceFB: '批改', feynmanQ: '费曼', feynmanDiag: '费曼诊断',
    probSolve: '习题解答', probAll: '习题全解', chSummary: '章节提纲', probSolves: '习题解答集'
  };

  function archive() {
    const S = global.APP.state;
    const arch = S.archive || {};
    const ids = Object.keys(arch);
    let h = '<div class="card"><div class="card-title">学习存档 <span class="tag">按小节自动保存，重新打开自动恢复</span></div>' +
      '<div class="tiny muted" style="line-height:1.9">每次生成的读前预习 / 解答 / 精读 / 术语卡 / 练习 / 费曼 / 学习包，都会按小节存到本机浏览器；' +
      '重新点开同一小节会自动恢复，刷新页面也不丢。空间不够时会自动淘汰最旧的存档。</div>' +
      '<div class="toolbar"><button class="btn" data-act="archive-export">导出全部为 Markdown</button>' +
      '<span class="tiny muted">共 ' + ids.length + ' 节有存档</span></div></div>';

    if (!ids.length) {
      h += '<div class="empty-state"><div class="big">🗂️</div>还没有存档。去学习台生成一次「读前预习」或「学习包」，就会自动出现在这里。</div>';
      return h;
    }

    const nodes = ids.map(sid => {
      const f = global.APP.findSection(sid);
      const a = arch[sid];
      if (!f || !a) return null;
      return { sid: sid, ch: f.chapter, sec: f.section, a: a };
    }).filter(Boolean).sort((x, y) => String(y.a.updatedAt || '').localeCompare(String(x.a.updatedAt || '')));

    nodes.forEach(n => {
      const keys = Object.keys(n.a).filter(k => k !== 'updatedAt' && k !== 'drafts' && k !== 'chat' && n.a[k]);
      const hasChat = n.a.chat && n.a.chat.display && n.a.chat.display.length;
      const tags = keys.map(k => '<span class="arc-tag">' + global.U.esc(ARCH_LAB[k] || k) + '</span>').join('') +
        (hasChat ? '<span class="arc-tag">追问 ' + n.a.chat.display.filter(m => m.role === 'user').length + '</span>' : '');
      h += '<div class="archive-card">' +
        '<div class="arc-head"><b>第 ' + n.ch.num + ' 章 · ' + global.U.esc(n.sec.num + ' ' + n.sec.title) + '</b>' +
        '<span class="tiny muted">' + global.U.esc(n.a.updatedAt || '') + '</span></div>' +
        '<div class="arc-tags">' + (tags || '<span class="tiny muted">（空）</span>') + '</div>' +
        '<div class="toolbar"><button class="btn small-btn primary" data-act="archive-open" data-id="' + n.sid + '">打开这一节</button>' +
        '<button class="btn small-btn ghost" data-act="archive-del" data-id="' + n.sid + '">删除存档</button></div>' +
        '</div>';
    });
    return h;
  }

  global.VIEWS_PLAN_PRESET = PLAN;
  global.VIEWS = { plan, glossary, mistakes, quiz, archive, PLAN };
})(window);
