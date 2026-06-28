/* ============================================================================
 * Nana UI — binds the pure engine to the DOM, drives AI turns, and triggers
 * the StepFun-powered NPC quips on hover. Browser only.
 * ==========================================================================*/
(function () {
  'use strict';
  const E = window.NanaEngine, IMG = window.CARD_IMAGES || {}, P = window.NANA_PERSONALITIES || {};
  const $ = function (s, r) { return (r || document).querySelector(s); };
  const $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  const esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
  const rnd = function (n) { return Math.floor(Math.random() * n); };

  const S = { G: null, mems: [], viewSeat: 0, busy: false, hoverTimer: 0, prevReshuffles: 0, cfg: null };

  // ---------- setup screen ----------
  function setupSeatCfg(n) {
    const wrap = $('#seatcfg'); wrap.innerHTML = '<h2>对手设置</h2>';
    const pkeys = Object.keys(P);
    for (let i = 1; i < n; i++) {
      const row = document.createElement('div'); row.className = 'row'; row.style.margin = '6px 0';
      let opts = '<option value="">随机性格</option>';
      pkeys.forEach(function (k) { opts += '<option value="' + k + '">' + esc(P[k].emoji + ' ' + P[k].name) + '</option>'; });
      row.innerHTML = '<b style="width:64px">对手 ' + i + '</b>' +
        '<select data-seat="' + i + '" class="opo-pers" style="max-width:220px">' + opts + '</select>' +
        '<label class="switch"><input type="checkbox" class="opo-human" data-seat="' + i + '"><span>真人(同屏)</span></label>';
      wrap.appendChild(row);
    }
  }
  function readConfig() {
    const n = +$('#pcount .on').dataset.n;
    const diff = $('#difficulty .on').dataset.d;
    const christmas = $('#xmas').checked;
    const usedPers = {};
    const pkeys = Object.keys(P);
    function randPers() { let k; let guard = 0; do { k = pkeys[rnd(pkeys.length)]; } while (usedPers[k] && guard++ < 20); usedPers[k] = 1; return k; }
    const players = [{ name: '你', isHuman: true, isAI: false }];
    for (let i = 1; i < n; i++) {
      const sel = $('.opo-pers[data-seat="' + i + '"]');
      const human = $('.opo-human[data-seat="' + i + '"]').checked;
      let pk = sel && sel.value ? sel.value : randPers();
      if (sel && sel.value) usedPers[pk] = 1;
      const pers = P[pk];
      players.push({
        name: human ? ('玩家 ' + (i + 1)) : (pers ? pers.name.replace(/\s*\(.*$/, '') : ('对手' + i)),
        isHuman: human, isAI: !human, difficulty: diff, personality: human ? null : pk
      });
    }
    return { numPlayers: n, players: players, christmas: christmas, diff: diff };
  }

  function startGame() {
    const cfg = readConfig(); S.cfg = cfg;
    NanaQuip.setKey($('#apikey').value.trim());
    NanaQuip.setModel($('#model').value);
    const seed = ((Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0) || (rnd(0x7fffffff) + 1);
    S.G = E.createGame({ numPlayers: cfg.numPlayers, players: cfg.players, christmas: cfg.christmas, seed: seed });
    S.mems = []; for (let i = 0; i < cfg.numPlayers; i++) S.mems.push(E.AI.newMemory(cfg.numPlayers));
    S.prevReshuffles = 0;
    // first human seat is the default view
    S.viewSeat = cfg.players.findIndex(function (p) { return p.isHuman; }); if (S.viewSeat < 0) S.viewSeat = 0;
    $('#setup').hidden = true; $('#game').hidden = false;
    updateKeyTags();
    render(); beginTurn();
  }

  function humansCount() { return S.G.players.filter(function (p) { return p.isHuman; }).length; }
  function isHumanTurn() { const G = S.G; return G.phase === 'playing' && G.players[G.activePlayer].isHuman && G.activePlayer === S.viewSeat && !S.busy; }

  // ---------- rendering ----------
  function faceCard(value, cls) {
    const d = document.createElement('div'); d.className = 'card ' + (cls || '');
    if (value != null && IMG[String(value)]) d.style.backgroundImage = 'url(' + IMG[String(value)] + ')';
    else d.style.backgroundImage = 'url(' + (IMG.back || '') + ')';
    return d;
  }
  function backCard(cls) { const d = document.createElement('div'); d.className = 'card ' + (cls || ''); d.style.backgroundImage = 'url(' + (IMG.back || '') + ')'; return d; }
  function setsPile(sets) {
    const w = document.createElement('div'); w.className = 'sets';
    sets.forEach(function (v) {
      const g = document.createElement('div'); g.className = 'setgrp';
      for (let k = 0; k < 3; k++) g.appendChild(faceCard(v, 'set'));
      w.appendChild(g);
    });
    return w;
  }
  function moveAttr(el, move) { el.dataset.move = JSON.stringify(move); el.classList.add('clickable'); }

  function render() {
    const G = S.G; const v = E.view(G, S.viewSeat);
    // topbar
    $('#turnchip').textContent = (G.phase === 'over' ? '游戏结束' : '轮到：' + G.players[G.activePlayer].name);
    const ac = $('#attemptchip');
    if (v.attempt.active) { ac.classList.remove('hide'); ac.textContent = '目标 ' + v.attempt.target + ' · 已凑 ' + v.attempt.matched + '/3'; }
    else ac.classList.add('hide');

    // opponents (everyone except the viewing seat)
    const opo = $('#opponents'); opo.innerHTML = '';
    for (let i = 0; i < G.numPlayers; i++) {
      if (i === S.viewSeat) continue;
      opo.appendChild(buildSeat(v, i, false));
    }
    // you
    const you = $('#you'); you.innerHTML = '';
    you.appendChild(buildSeat(v, S.viewSeat, true));

    // log
    const logEl = $('#log');
    logEl.innerHTML = v.log.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    logEl.scrollTop = logEl.scrollHeight;

    // grid
    const grid = $('#grid'); grid.innerHTML = '';
    const cols = Math.min(v.grid.length, v.grid.length <= 6 ? 6 : 5);
    grid.style.gridTemplateColumns = 'repeat(' + Math.max(1, cols) + ', auto)';
    v.grid.forEach(function (c, idx) {
      let el;
      if (c.collected) { el = document.createElement('div'); el.className = 'card empty'; }
      else if (c.faceUp) { el = faceCard(c.value, 'target'); }
      else { el = backCard(''); if (isHumanTurn()) moveAttr(el, { kind: 'grid', gridIndex: idx }); }
      grid.appendChild(el);
    });
  }

  function buildSeat(v, i, isYou) {
    const p = v.players[i]; const active = (i === v.activePlayer && S.G.phase === 'playing');
    const seat = document.createElement('div');
    seat.className = 'seat' + (active ? ' active' : ''); seat.dataset.seat = i;
    const pers = p.personality ? P[p.personality] : null;
    const badge = pers ? ('<div class="pbadge" style="background:' + pers.color + '">' + pers.emoji + '</div>') :
      ('<div class="pbadge" style="background:#3a6">' + (isYou ? '🙂' : '👤') + '</div>');
    const sub = pers ? pers.name.replace(/\s*\(.*$/, '') : (p.isHuman ? '真人' : '');
    seat.innerHTML = '<div class="head">' + badge +
      '<div class="who">' + esc(p.name) + '<small>' + esc(sub) + '</small></div>' +
      '<div class="stat">手牌 ' + p.handCount + '<br>已凑 ' + p.sets.length + ' 组</div></div>';

    // hand
    const hand = document.createElement('div'); hand.className = 'cards';
    if (isYou && p.hand) {
      p.hand.forEach(function (val, idx) {
        const el = faceCard(val, '');
        const end = idx === 0 ? 'smallest' : (idx === p.hand.length - 1 ? 'biggest' : null);
        if (isHumanTurn() && end) { tagEnd(el, end); moveAttr(el, { kind: 'hand', owner: i, end: end }); }
        hand.appendChild(el);
      });
    } else {
      for (let k = 0; k < p.handCount; k++) {
        const el = backCard('sm');
        const isEnd = (k === 0) || (k === p.handCount - 1 && p.handCount > 1);
        if (isHumanTurn() && isEnd) {
          const end = (k === 0) ? 'smallest' : 'biggest';
          tagEnd(el, end); moveAttr(el, { kind: 'hand', owner: i, end: end });
          if (!p.isHuman) attachHover(el, i, end);
        }
        hand.appendChild(el);
      }
    }
    seat.appendChild(hand);

    // current revealed pile
    if (p.revealed && p.revealed.length) {
      const lab = document.createElement('div'); lab.className = 'mini'; lab.textContent = '本回合翻出';
      seat.appendChild(lab);
      const rev = document.createElement('div'); rev.className = 'cards';
      p.revealed.forEach(function (val) { rev.appendChild(faceCard(val, 'sm target')); });
      seat.appendChild(rev);
    }
    // sets
    if (p.sets.length) { const lab = document.createElement('div'); lab.className = 'mini'; lab.textContent = '已凑成的组'; seat.appendChild(lab); seat.appendChild(setsPile(p.sets)); }
    return seat;
  }
  function tagEnd(el, end) { const t = document.createElement('div'); t.className = 'endtag'; t.textContent = end === 'smallest' ? '最小▾' : '最大▴'; el.appendChild(t); el.classList.add('askable'); }

  // ---------- hover quips ----------
  function attachHover(el, seatIdx, end) {
    el.addEventListener('mouseenter', function () { onHover(seatIdx, end); });
    el.addEventListener('mouseleave', function () { clearTimeout(S.hoverTimer); });
  }
  function hoverMsg(p, end) {
    return '在《Nana》对局里，人类玩家正把鼠标停在你“' + (end === 'smallest' ? '最小' : '最大') +
      '”的那张手牌上，犹豫要不要逼你翻开它。你现在还有 ' + p.handCount + ' 张手牌。用你的性格说一句话影响他的决定。';
  }
  function onHover(seatIdx, end) {
    const G = S.G; if (!isHumanTurn()) return;
    const p = G.players[seatIdx]; if (!p.isAI || !p.personality) return;
    clearTimeout(S.hoverTimer);
    S.hoverTimer = setTimeout(function () {
      const ck = end + '|t' + G.turnCount;
      const cached = NanaQuip.cachedOnly(p.personality, 'hover', ck);
      if (cached) { showBubble(seatIdx, cached, true); return; }
      // instant scripted line, then upgrade to the live StepFun line when it arrives
      showBubble(seatIdx, NanaQuip.fallback(p.personality, 'hover'), false);
      if (!NanaQuip.hasKey()) return;
      NanaQuip.line(p.personality, 'hover', hoverMsg(E.view(G, S.viewSeat).players[seatIdx], end), ck)
        .then(function (line) { if (G.activePlayer === S.viewSeat && G.phase === 'playing') showBubble(seatIdx, line, true); });
    }, 260);
  }
  function showBubble(seatIdx, text, live, loading) {
    const seat = $('.seat[data-seat="' + seatIdx + '"]'); if (!seat) return;
    const old = seat.querySelector('.bubble'); if (old) old.remove();
    const b = document.createElement('div'); b.className = 'bubble' + (live ? ' live' : '');
    b.innerHTML = '<span class="src">' + (live ? '🛰 StepFun' : '内置台词') + '</span>' + esc(text);
    seat.appendChild(b);
    clearTimeout(b._t); b._t = setTimeout(function () { b.remove(); }, loading ? 16000 : 5200);
  }
  function primeOpponentQuips() {
    const G = S.G; if (!NanaQuip.hasKey()) return;
    const vw = E.view(G, S.viewSeat);
    let spoke = false;
    for (let i = 0; i < G.numPlayers; i++) {
      if (i === S.viewSeat) continue; const p = G.players[i]; if (!p.isAI || !p.personality) continue;
      NanaQuip.prime(p.personality, 'hover', hoverMsg(vw.players[i], 'smallest'), 'smallest|t' + G.turnCount);
      NanaQuip.prime(p.personality, 'hover', hoverMsg(vw.players[i], 'biggest'), 'biggest|t' + G.turnCount);
      if (!spoke && Math.random() < 0.6) {
        spoke = true;
        NanaQuip.line(p.personality, 'turnStart', '轮到人类玩家了。用你的性格挑衅或忽悠他一句。', 'ts|t' + G.turnCount)
          .then(function (l) { if (isHumanTurn()) showBubble(i, l, NanaQuip.hasKey()); });
      }
    }
  }

  // ---------- turn flow ----------
  function setPrompt(t) { $('#prompt').textContent = t; }
  function beginTurn() {
    const G = S.G; if (G.phase === 'over') { showWin(); return; }
    const pi = G.activePlayer, p = G.players[pi];
    if (p.isHuman) {
      if (pi !== S.viewSeat && humansCount() > 1) { showGate(pi); return; }
      S.viewSeat = pi; S.busy = false; render();
      setPrompt(p.name + ' 的回合：点一张可翻的牌（对手🟡两端 / 桌面牌堆 / 你自己的两端）。第一张决定目标数字。');
      primeOpponentQuips();
    } else {
      S.busy = true; render(); setPrompt('🤖 ' + p.name + ' 正在思考…');
      setTimeout(aiStep, 800);
    }
  }
  function aiStep() {
    const G = S.G; if (G.phase !== 'playing') return;
    const pi = G.activePlayer; if (!G.players[pi].isAI) return;
    const mv = E.AI.chooseReveal(G, S.mems[pi], pi, G.players[pi].difficulty);
    if (!mv) { setTimeout(function () { E.applyReveal(G, null); }, 10); return; }
    applyMove(mv);
  }
  function onClickCard(ev) {
    const card = ev.target.closest('.card.clickable'); if (!card || !card.dataset.move) return;
    if (!isHumanTurn()) return;
    const move = JSON.parse(card.dataset.move);
    clearTimeout(S.hoverTimer);
    applyMove(move);
  }
  function applyMove(move) {
    const G = S.G; S.busy = true;
    const resolver = G.activePlayer;
    try { E.applyReveal(G, move); } catch (e) { S.busy = false; return; }
    observeAll(G.lastReveal); memInvalidate();
    render();
    if (G.phase === 'over') { setPrompt(''); setTimeout(showWin, 700); return; }
    if (G.lastOutcome === 'continue') {
      if (G.players[G.activePlayer].isAI) setTimeout(aiStep, 720);
      else { S.busy = false; render(); setPrompt('🎯 目标 ' + G.attempt.target + '：必须继续翻直到第 3 张相同 或 翻错！已凑 ' + G.attempt.matched + '/3'); }
      return;
    }
    outcomeFx(resolver);
    setTimeout(beginTurn, 1150);
  }
  function observeAll(reveal) { for (let k = 0; k < S.G.numPlayers; k++) E.AI.observe(S.mems[k], reveal); }
  function memInvalidate() {
    const G = S.G;
    if (G.reshuffles > S.prevReshuffles) {
      S.prevReshuffles = G.reshuffles;
      S.mems = G.players.map(function () { return E.AI.newMemory(G.numPlayers); });
      toast('🔄 出现僵局，自动重洗未收集的牌', 'info');
      return;
    }
    if (G.lastOutcome === 'success' && G.lastResolution) {
      const sv = G.lastResolution.setValue;
      const xmas = G.christmas && [2, 4, 6, 8, 10].indexOf(sv) >= 0;
      if (xmas) { for (let k = 0; k < G.numPlayers; k++) for (let pj = 0; pj < G.numPlayers; pj++) E.AI.forgetEnds(S.mems[k], pj); }
      else (G.lastResolution.stolenFrom || []).forEach(function (pj) { for (let k = 0; k < G.numPlayers; k++) E.AI.forgetEnds(S.mems[k], pj); });
    }
  }
  function outcomeFx(resolver) {
    const G = S.G, r = G.lastResolution || {};
    const rp = G.players[resolver];
    if (G.lastOutcome === 'success') {
      toast('✅ ' + rp.name + ' 凑成一组 ' + r.setValue + (r.stolenFrom && r.stolenFrom.length ? '（抢牌！）' : ''), 'good');
      if (rp.isAI && rp.personality) NanaQuip.line(rp.personality, 'gloat', '你刚凑成一组牌，得意地说一句。', 'g' + G.turnCount).then(function (l) { showBubble(resolver, l, NanaQuip.hasKey()); });
      (r.stolenFrom || []).forEach(function (pj) {
        const vp = G.players[pj];
        if (vp.isAI && vp.personality) setTimeout(function () { NanaQuip.line(vp.personality, 'robbed', '你的牌刚被对手抢走，说一句。', 'r' + G.turnCount).then(function (l) { showBubble(pj, l, NanaQuip.hasKey()); }); }, 500);
      });
    } else {
      toast('💥 ' + rp.name + ' 翻车了！', 'bad');
    }
  }

  // ---------- gate / win / toast ----------
  function showGate(pi) {
    const g = $('#gate'); g.hidden = false;
    g.innerHTML = '<div class="panel"><div class="pad" style="text-align:center">' +
      '<h1>请把设备交给</h1><div class="winbig">' + esc(S.G.players[pi].name) + '</div>' +
      '<p>其他人请不要偷看 🙈</p><button class="btn big" id="gateGo">我准备好了 ▶</button></div></div>';
    $('#gateGo').onclick = function () { g.hidden = true; S.viewSeat = pi; beginTurn(); };
  }
  function toast(text, kind) {
    const t = $('#toast'); t.textContent = text; t.className = (kind || 'info') + ' show';
    clearTimeout(t._t); t._t = setTimeout(function () { t.className = (kind || 'info'); }, 2200);
  }
  function showWin() {
    const G = S.G; const w = $('#win'); w.hidden = false;
    const ranking = G.players.map(function (p, i) { return { i: i, name: p.name, sets: p.sets.slice() }; })
      .sort(function (a, b) { return b.sets.length - a.sets.length; });
    let rows = ranking.map(function (r, idx) {
      return '<tr><td>' + (idx === 0 ? '🥇' : (idx === 1 ? '🥈' : (idx === 2 ? '🥉' : '　'))) + '</td><td><b>' + esc(r.name) + '</b></td><td>' +
        (r.sets.length ? r.sets.map(function (v) { return '<span style="display:inline-block;background:#1f6e4d;color:#fff;border-radius:6px;padding:1px 7px;margin:1px;font-weight:800">' + v + '</span>'; }).join('') : '—') + '</td></tr>';
    }).join('');
    w.innerHTML = '<div class="panel"><div class="pad" style="text-align:center">' +
      '<h1>🏆 ' + esc(G.players[G.winner].name) + ' 获胜！</h1>' +
      '<p style="font-size:15px"><b>' + esc(G.winReason || '') + '</b></p>' +
      '<table class="legend" style="margin:10px 0">' + rows + '</table>' +
      (G.reshuffles ? '<p class="hint">本局自动重洗了 ' + G.reshuffles + ' 次以打破僵局。</p>' : '') +
      '<button class="btn big" id="againBtn">再来一局 ▶</button></div></div>';
    $('#againBtn').onclick = function () { w.hidden = true; $('#game').hidden = true; $('#setup').hidden = false; };
  }

  function updateKeyTags() {
    const on = NanaQuip.hasKey();
    [['#keytag', on], ['#keytag2', on]].forEach(function (x) {
      const el = $(x[0]); if (!el) return;
      el.className = 'keytag ' + (on ? 'on' : 'off');
      el.textContent = on ? '🛰 StepFun 已接入' : '内置台词（无 Key）';
    });
  }

  // ---------- wiring ----------
  function seg(id, onPick) {
    $$('#' + id + ' button').forEach(function (b) {
      b.onclick = function () { $$('#' + id + ' button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); if (onPick) onPick(b); };
    });
  }
  function init() {
    seg('pcount', function (b) { setupSeatCfg(+b.dataset.n); });
    seg('difficulty');
    setupSeatCfg(+$('#pcount .on').dataset.n);
    $('#apikey').addEventListener('input', function () { NanaQuip.setKey(this.value.trim()); updateKeyTags(); });
    updateKeyTags();
    $('#start').onclick = startGame;
    $('#howto').onclick = function () { $('#rules').hidden = false; };
    $('#rulesBtn').onclick = function () { $('#rules').hidden = false; };
    $('#restartBtn').onclick = function () { $('#game').hidden = true; $('#setup').hidden = false; };
    $('#setBtn').onclick = function () { $('#apikey2').value = NanaQuip.getKey(); $('#model2').value = NanaQuip.getModel(); $('#settings').hidden = false; };
    $('#saveSettings').onclick = function () { NanaQuip.setKey($('#apikey2').value.trim()); NanaQuip.setModel($('#model2').value); updateKeyTags(); $('#settings').hidden = true; };
    $$('[data-close]').forEach(function (b) { b.onclick = function () { $('#' + b.dataset.close).hidden = true; }; });
    $('#game').addEventListener('click', onClickCard);
    // restore saved key
    if (NanaQuip.getKey()) $('#apikey').value = NanaQuip.getKey();
    $('#model').value = NanaQuip.getModel();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.__NANA = S; // debug/inspection handle
})();
