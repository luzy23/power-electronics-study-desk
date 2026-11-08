/* ============================================================
 * prompts.js — 从 /content/prompts.txt 加载提示词与演示内容
 * 文件格式：
 *   @@@ system
 *   ...正文...
 *   @@@ pre
 *   ...正文...
 *   @@@ demo:pre
 *   ...
 * 正文中的 {{name}} 会被 ctx 中的同名字段替换。
 * ============================================================ */
(function (global) {
  'use strict';

  const P = { _map: null, _loading: null, _custom: {} };

  /** 设置自定义提示词覆盖（task -> 文本）；传 null/{} 清空 */
  P.setCustom = function (map) {
    P._custom = map || {};
  };

  P.getCustom = function () { return P._custom || {}; };

  /** 列出所有可编辑的任务名（不含 demo: 演示文本） */
  P.names = async function () {
    const m = await P.load();
    return Object.keys(m).filter(n => n.indexOf('demo:') !== 0);
  };

  /** 取任务预设文本（忽略自定义覆盖） */
  P.preset = async function (name) {
    const m = await P.load();
    return m[name] || '';
  };

  function parse(txt) {
    const map = {};
    let cur = null;
    const buf = [];
    const flush = () => { if (cur !== null) map[cur] = buf.join('\n').trim(); };
    txt.split(/\r?\n/).forEach((line) => {
      const m = /^@@@\s+(\S+)\s*$/.exec(line);
      if (m) {
        flush();
        buf.length = 0;
        cur = m[1];
      } else if (cur !== null) {
        buf.push(line);
      }
    });
    flush();
    return map;
  }

  function fill(tpl, ctx) {
    if (!tpl) return '';
    return tpl.replace(/\{\{(\w+)\}\}/g, (all, key) => {
      const v = ctx ? ctx[key] : undefined;
      return (v === undefined || v === null) ? '' : String(v);
    });
  }

  P.load = async function () {
    if (P._map) return P._map;
    if (!P._loading) {
      P._loading = fetch('/content/prompts.txt', { cache: 'no-store' })
        .then((r) => {
          if (!r.ok) throw new Error('无法加载提示词文件（' + r.status + '）');
          return r.text();
        })
        .then((txt) => {
          P._map = parse(txt);
          if (!P._map.system) throw new Error('提示词文件缺少 system 段');
          return P._map;
        });
    }
    return P._loading;
  };

  /** 返回 OpenAI 兼容的 messages 数组 */
  P.build = async function (name, ctx) {
    const m = await P.load();
    const tpl = (P._custom && P._custom[name] !== undefined && P._custom[name] !== '') ? P._custom[name] : m[name];
    const body = fill(tpl, ctx);
    if (!body) throw new Error('缺少提示词段落：' + name);
    return [
      { role: 'system', content: m.system },
      { role: 'user', content: body }
    ];
  };

  /** 演示模式文本（自定义只覆盖 demo: 键，避免把提示词当示例输出） */
  P.demo = async function (name, ctx) {
    const m = await P.load();
    const key = 'demo:' + name;
    const tpl = (P._custom && P._custom[key]) ? P._custom[key] : m[key];
    const body = fill(tpl || '', ctx || {});
    return body || '（演示模式下暂无该任务的示例内容，请配置 API Key 后使用。）';
  };

  P.raw = async function (name) {
    const m = await P.load();
    if (P._custom && P._custom[name] !== undefined && P._custom[name] !== '') return P._custom[name];
    return m[name] || '';
  };

  global.PROMPTS = P;
})(window);
