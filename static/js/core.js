/* ============================================================
 * core.js — 通用工具：DOM / 存储 / Markdown+LaTeX 渲染
 * ============================================================ */
(function (global) {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms || 2600);
  }

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('pe.' + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('pe.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ }
    },
    del(k) { try { localStorage.removeItem('pe.' + k); } catch (e) { /* ignore */ } }
  };

  function md(text) {
    const src = String(text || '');
    // --- 1) 统一数学定界符，并把公式块先变成占位符，避免 marked 把
    //        $$ 行、换行、下划线当成 Markdown 处理 ---
    let pre = src.replace(/\r\n/g, '\n');
    const mathBlocks = [];
    const holdMath = (tex, display) => {
      const t = String(tex || '').trim();
      if (!t) return '';
      mathBlocks.push({ tex: t, display: !!display });
      return '\u0003' + (mathBlocks.length - 1) + '\u0004';
    };
    // \[...\] / \(...\)
    pre = pre.replace(/\\\[([\s\S]*?)\\\]/g, (m, t) => holdMath(t, true));
    pre = pre.replace(/\\\(([\s\S]*?)\\\)/g, (m, t) => holdMath(t, false));
    // $$...$$ 显示公式（优先于行内）
    pre = pre.replace(/\$\$([\s\S]*?)\$\$/g, (m, t) => holdMath(t, true));
    // 模型偶尔多打一行孤立的 $$（或空块），直接清掉
    pre = pre.replace(/^[ \t]*\$\$[ \t]*$/gm, '');

    // --- 2) 保护剩余的反斜杠定界符（极少见） ---
    const saved = [];
    const save = (m) => { saved.push(m); return '\u0001' + (saved.length - 1) + '\u0002'; };
    pre = pre
      .replace(/\\\(/g, () => save('\\('))
      .replace(/\\\)/g, () => save('\\)'))
      .replace(/\\\[/g, () => save('\\['))
      .replace(/\\\]/g, () => save('\\]'));

    // --- 3) 模型有时把公式写成普通括号 (P=I^2R...\times...) ，补成 $...$ ---
    pre = pre.replace(/\(([^()\n]{0,300}?\\[a-zA-Z][^()\n]{0,300}?)\)/g, (m, inner) => {
      if (/[\u4e00-\u9fff]/.test(inner)) return m;
      if (/^\$|\$$/.test(inner)) return m;
      return '$' + inner + '$';
    });

    let html;
    if (global.marked && global.marked.parse) {
      try { html = global.marked.parse(pre, { gfm: true, breaks: true }); }
      catch (e) { html = '<pre>' + esc(pre) + '</pre>'; }
    } else {
      html = '<pre>' + esc(pre) + '</pre>';
    }
    // 还原剩余定界符
    html = html.replace(/\u0001(\d+)\u0002/g, (m, i) => saved[Number(i)] || '');
    // 还原公式块：用 data-tex 交给 KaTeX 直接渲染，不再依赖 auto-render
    html = html.replace(/\u0003(\d+)\u0004/g, (m, i) => {
      const b = mathBlocks[Number(i)];
      if (!b) return '';
      return '<span class="' + (b.display ? 'math-display' : 'math-inline') +
        '" data-tex="' + encodeURIComponent(b.tex) + '"></span>';
    });

    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
      .replace(/javascript:/gi, '');
  }

  function renderMath(el) {
    if (!el) return;
    // 先渲染我们保护下来的公式块
    if (global.katex && global.katex.render) {
      el.querySelectorAll('[data-tex]').forEach(node => {
        try {
          const tex = decodeURIComponent(node.getAttribute('data-tex') || '');
          global.katex.render(tex, node, {
            displayMode: node.classList.contains('math-display'),
            throwOnError: false,
            strict: 'ignore'
          });
        } catch (e) { /* 单个公式失败不影响全文 */ }
      });
    }
    // 再处理普通 $...$ / 其它剩余定界符
    if (!global.renderMathInElement) return;
    try {
      global.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false }
        ],
        throwOnError: false,
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
      });
    } catch (e) { /* ignore */ }
  }

  function renderMarkdown(el, text, withMath) {
    if (!el) return;
    el.innerHTML = md(text);
    if (withMath !== false) renderMath(el);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    return Promise.resolve();
  }

  function downloadFile(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  }

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function nowStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return today() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  let uidSeq = 0;
  function uid() { return Date.now().toString(36) + '-' + (++uidSeq); }

  function scrollToBottom(el) {
    if (el) el.scrollTop = el.scrollHeight;
  }

  global.U = { $, $$, esc, toast, store, md, renderMath, renderMarkdown, copyText, downloadFile, today, nowStr, uid, scrollToBottom };
})(window);
