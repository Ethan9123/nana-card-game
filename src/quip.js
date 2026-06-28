/* ============================================================================
 * NanaQuip — runtime NPC "psychological warfare" via the StepFun API.
 * Browser only. Calls StepFun with the player's own key (from localStorage,
 * never committed). Falls back to scripted personality lines on any failure,
 * so the game is always playable even without a key.
 * Verified config: Authorization: Bearer, enable_thinking:false, ~400 tokens,
 * model step-3.5-flash, CORS-open endpoint.
 * ==========================================================================*/
(function (root) {
  'use strict';
  const ENDPOINT = 'https://api.stepfun.com/step_plan/v1/messages';
  const LS_KEY = 'nana_stepfun_key';
  const LS_MODEL = 'nana_stepfun_model';
  const cache = {};
  const P = root.NANA_PERSONALITIES || {};

  function ls(get, k, v) { try { return get ? (localStorage.getItem(k) || '') : localStorage.setItem(k, v); } catch (e) { return ''; } }
  function getKey() { return ls(true, LS_KEY); }
  function setKey(k) { ls(false, LS_KEY, k || ''); }
  function getModel() { return ls(true, LS_MODEL) || 'step-3.5-flash'; }
  function setModel(m) { ls(false, LS_MODEL, m || 'step-3.5-flash'); }
  function hasKey() { return !!getKey(); }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function fallback(pk, situation) {
    const p = P[pk];
    if (!p || !p.fallback) return '…';
    const arr = p.fallback[situation] || p.fallback.hover || ['…'];
    return pick(arr);
  }

  async function apiQuip(pk, userMsg) {
    const p = P[pk]; const key = getKey();
    if (!key || !p) throw new Error('no-key');
    const body = { model: getModel(), max_tokens: 420, enable_thinking: false, system: p.system,
      messages: [{ role: 'user', content: userMsg }] };
    const ctrl = new AbortController();
    const to = setTimeout(function () { ctrl.abort(); }, 15000);
    let resp;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctrl.signal
      });
    } finally { clearTimeout(to); }
    if (!resp.ok) throw new Error('http ' + resp.status);
    const j = await resp.json();
    let text = (j.content || []).filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; }).join('').trim();
    text = text.replace(/^[\s"“”'’]+|[\s"“”'’]+$/g, '').trim();
    if (text.length > 60) text = text.slice(0, 60);
    if (!text) throw new Error('empty');
    return text;
  }

  // Resolve a line: cache -> live API -> scripted fallback. Never rejects.
  async function line(pk, situation, userMsg, cacheKey) {
    const ck = pk + '|' + situation + '|' + (cacheKey || userMsg);
    if (cache[ck]) return cache[ck];
    if (!hasKey()) return fallback(pk, situation);
    try { const t = await apiQuip(pk, userMsg); cache[ck] = t; return t; }
    catch (e) { return fallback(pk, situation); }
  }
  function cachedOnly(pk, situation, cacheKey) { return cache[pk + '|' + situation + '|' + cacheKey] || null; }
  // fire-and-forget prefetch to warm the cache
  function prime(pk, situation, userMsg, cacheKey) {
    const ck = pk + '|' + situation + '|' + (cacheKey || userMsg);
    if (cache[ck] || !hasKey()) return;
    apiQuip(pk, userMsg).then(function (t) { cache[ck] = t; }).catch(function () {});
  }

  root.NanaQuip = { getKey, setKey, getModel, setModel, hasKey, line, fallback, prime, cachedOnly };
})(window);
