/* ============================================================
 * api.js — 配置、教材数据、OpenAI 兼容流式接口
 * ============================================================ */
(function (global) {
  'use strict';

  const CFG_KEY = 'pe.cfg';
  const DEFAULT_CFG = {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.4,
    demo: false
  };

  function lsGet(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }

  const API = {
    lsGet, lsSet,
    lastFinish: null,        // 最近一次流式请求的 finish_reason（'length' = 被输出上限截断）
    cfg() { return Object.assign({}, DEFAULT_CFG, lsGet(CFG_KEY, {})); },
    saveCfg(c) { lsSet(CFG_KEY, c); },
    isDemo() {
      const c = API.cfg();
      return !!c.demo || !String(c.apiKey || '').trim();
    },
    modeLabel() {
      const c = API.cfg();
      if (c.demo) return '演示模式';
      if (!String(c.apiKey || '').trim()) return '未配置 API';
      return c.model || 'API 已配置';
    },

    async json(url) {
      const r = await fetch(url, { cache: 'no-store' });
      let body = null;
      try { body = await r.json(); } catch (e) { /* ignore */ }
      if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
      return body;
    },
    book() { return API.json('/api/book'); },
    section(id) { return API.json('/api/section?id=' + encodeURIComponent(id)); },
    chapter(id, max) { return API.json('/api/chapter?id=' + encodeURIComponent(id) + '&max=' + (max || 24000)); },
    chapterFull(id) { return API.json('/api/chapterfull?id=' + encodeURIComponent(id)); },
    backups() { return API.json('/api/backups'); },
    async backup(data, note) {
      const r = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, note: note || '' })
      });
      let j = null;
      try { j = await r.json(); } catch (e) { /* ignore */ }
      if (!r.ok || (j && j.error)) throw new Error((j && j.error) || ('HTTP ' + r.status));
      return j;
    },
    probs(id) { return API.json('/api/probs?id=' + encodeURIComponent(id)); },
    pageUrl(n, dpi) { return '/api/page?n=' + n + '&dpi=' + (dpi || 120); },

    /** 流式对话；onDelta(text) 逐段回调 */
    async stream(messages, opts) {
      const o = opts || {};
      const cfg = API.cfg();
      if (!String(cfg.apiKey || '').trim()) throw new Error('未配置 API Key：请点右上角「设置」填写。');
      const payload = {
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        messages: messages,
        temperature: (o.temperature != null ? o.temperature : cfg.temperature),
        stream: true
      };
      if (o.maxTokens) payload.max_tokens = o.maxTokens;
      else if (/deepseek/i.test(cfg.baseUrl || '')) payload.max_tokens = 8192;
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.apiKey
        },
        body: JSON.stringify(payload),
        signal: o.signal
      });
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      if (!res.body) throw new Error('当前浏览器不支持流式响应');
      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      let buf = '';
      let finished = false;
      let finishReason = null;
      while (!finished) {
        const r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const evt = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = evt.split('\n');
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (!data) continue;
            if (data === '[DONE]') { finished = true; break; }
            let j = null;
            try { j = JSON.parse(data); } catch (e) { continue; }   // 可能是被截断的半包
            if (j.error) throw new Error(j.error);
            const choice = j.choices && j.choices[0];
            if (choice && choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice && (choice.delta || choice.message);
            if (delta && delta.content) o.onDelta(delta.content);
          }
          if (finished) break;
        }
      }
      API.lastFinish = finishReason;
      return { finish: finishReason };
    },

    /** 拉取该接口支持的模型列表 */
    async models(baseUrl, apiKey) {
      const base = String(baseUrl || '').trim();
      if (!base) throw new Error('请先填写 Base URL');
      const r = await fetch('/api/models?baseUrl=' + encodeURIComponent(base), {
        headers: { 'Authorization': 'Bearer ' + String(apiKey || '') },
        cache: 'no-store'
      });
      let j = null;
      try { j = await r.json(); } catch (e) { /* ignore */ }
      if (!r.ok || (j && j.error)) throw new Error((j && j.error) || ('HTTP ' + r.status));
      return (j && j.models) || [];
    },

    /** 非流式小请求，用于「测试连接」 */
    async test() {
      const cfg = API.cfg();
      if (!String(cfg.apiKey || '').trim()) throw new Error('请先填写 API Key');
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          messages: [{ role: 'user', content: '只回复两个字：可用' }],
          temperature: 0,
          max_tokens: 20,
          stream: false
        })
      });
      let j = null;
      try { j = await res.json(); } catch (e) { /* ignore */ }
      if (!res.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
      if (j && j.error) throw new Error(j.error);
      const txt = j && j.choices && j.choices[0] && (j.choices[0].message || {}).content;
      return txt || '（空响应）';
    }
  };

  global.API = API;
})(window);
