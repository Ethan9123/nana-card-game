/* ============================================================================
 * Nana — pure game engine + move AI.  No DOM, no Math.random, no Date.
 * Runs in the browser and in Node (require) for headless simulation tests.
 * ==========================================================================*/
(function (root) {
  'use strict';

  // ---- seedable RNG (mulberry32) ------------------------------------------
  function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    const next = function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return next;
  }

  const HAND_SIZE = { 2: 10, 3: 8, 4: 7, 5: 6 };
  const GRID_SIZE = { 2: 10, 3: 9, 4: 8, 5: 6 };
  const CHRISTMAS_VALUES = { 2: 1, 4: 1, 6: 1, 8: 1, 10: 1 };
  const TURN_CAP = 4000;

  function buildDeck(numPlayers) {
    let maxVal = 12;
    if (numPlayers === 2) maxVal = 10;      // remove 11s and 12s
    else if (numPlayers === 3) maxVal = 11; // remove 12s
    const deck = [];
    for (let v = 1; v <= maxVal; v++) { deck.push(v, v, v); }
    return deck;
  }

  function sortHand(h) { h.sort(function (a, b) { return a - b; }); return h; }

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function createGame(opts) {
    const n = opts.numPlayers;
    if (!HAND_SIZE[n]) throw new Error('numPlayers must be 2..5');
    const seed = (opts.seed >>> 0) || 1;
    const rng = makeRng(seed);
    const deck = shuffle(buildDeck(n), rng);

    const players = [];
    for (let i = 0; i < n; i++) {
      const pdef = (opts.players && opts.players[i]) || {};
      players.push({
        id: i,
        name: pdef.name || ('Player ' + (i + 1)),
        isHuman: !!pdef.isHuman,
        isAI: pdef.isAI !== undefined ? !!pdef.isAI : !pdef.isHuman,
        difficulty: pdef.difficulty || 'medium',
        personality: pdef.personality || null,
        hand: [],
        sets: [],
        revealed: []   // values revealed from THIS player's hand during current attempt
      });
    }

    const handSize = HAND_SIZE[n];
    for (let r = 0; r < handSize; r++) {
      for (let i = 0; i < n; i++) players[i].hand.push(deck.pop());
    }
    players.forEach(function (p) { sortHand(p.hand); });

    const grid = [];
    const gridSize = GRID_SIZE[n];
    for (let i = 0; i < gridSize; i++) {
      grid.push({ value: deck.pop(), faceUp: false, collected: false });
    }

    const G = {
      seed: seed,
      rng: rng,
      numPlayers: n,
      christmas: !!opts.christmas,
      turnCount: 0,
      activePlayer: Math.floor(rng() * n),
      phase: 'playing',
      winner: null,
      winReason: null,
      players: players,
      grid: grid,
      attempt: { active: false, target: null, matched: 0, reveals: [] },
      lastReveal: null,
      lastOutcome: null,
      reshuffles: 0,
      log: []
    };
    log(G, 'Game start: ' + n + ' players. ' + players[G.activePlayer].name + ' goes first.');
    return G;
  }

  function log(G, msg) { G.log.push(msg); if (G.log.length > 400) G.log.shift(); }

  // ---- legal reveals for the active player --------------------------------
  function legalReveals(G) {
    if (G.phase !== 'playing') return [];
    const moves = [];
    for (let pi = 0; pi < G.numPlayers; pi++) {
      const h = G.players[pi].hand;
      if (h.length >= 1) moves.push({ kind: 'hand', owner: pi, end: 'smallest' });
      if (h.length >= 2) moves.push({ kind: 'hand', owner: pi, end: 'biggest' });
    }
    for (let i = 0; i < G.grid.length; i++) {
      const c = G.grid[i];
      if (!c.collected && !c.faceUp) moves.push({ kind: 'grid', gridIndex: i });
    }
    return moves;
  }

  function moveValue(G, move) {
    if (move.kind === 'grid') return G.grid[move.gridIndex].value;
    const h = G.players[move.owner].hand;
    return move.end === 'smallest' ? h[0] : h[h.length - 1];
  }

  // ---- win logic ----------------------------------------------------------
  function winValue(sets) {
    if (sets.length >= 3) return '集齐 3 组牌 (3 sets)';
    if (sets.indexOf(7) !== -1) return '集齐一组 7 (a set of 7s)';
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const a = sets[i], b = sets[j];
        if (a + b === 7 || Math.abs(a - b) === 7) {
          return '两组牌之和/差为 7 (' + a + ' & ' + b + ')';
        }
      }
    }
    return null;
  }
  function checkWin(player) { return winValue(player.sets); }

  // ---- apply a single reveal (mutates G, returns G) -----------------------
  function applyReveal(G, move) {
    if (G.phase !== 'playing') return G;
    const at = G.attempt;
    let value, reveal;

    if (move.kind === 'grid') {
      const c = G.grid[move.gridIndex];
      if (c.collected || c.faceUp) throw new Error('illegal grid reveal');
      c.faceUp = true;
      value = c.value;
      reveal = { kind: 'grid', owner: null, gridIndex: move.gridIndex, value: value };
    } else {
      const owner = G.players[move.owner];
      if (owner.hand.length === 0) throw new Error('illegal hand reveal: empty');
      const idx = move.end === 'smallest' ? 0 : owner.hand.length - 1;
      value = owner.hand[idx];
      owner.hand.splice(idx, 1);
      owner.revealed.push(value);
      reveal = { kind: 'hand', owner: move.owner, gridIndex: null, value: value, end: move.end };
    }

    G.lastReveal = reveal;

    if (!at.active) {
      at.active = true; at.target = value; at.matched = 1; at.reveals = [reveal];
      G.lastOutcome = 'continue';
      log(G, name(G) + ' 翻出 ' + value + '，目标锁定为 ' + value + '。');
      return G;
    }

    at.reveals.push(reveal);
    if (value === at.target) {
      at.matched += 1;
      log(G, name(G) + ' 又翻出一张 ' + value + '（' + at.matched + '/3）。');
      if (at.matched >= 3) return resolveSuccess(G);
      G.lastOutcome = 'continue';
      return G;
    }

    log(G, name(G) + ' 翻出 ' + value + '，与目标 ' + at.target + ' 不符——失败！');
    return resolveBust(G);
  }

  function name(G, pi) { return G.players[pi === undefined ? G.activePlayer : pi].name; }

  function resolveSuccess(G) {
    const at = G.attempt;
    const pi = G.activePlayer;
    const target = at.target;
    const stolenFrom = [];

    for (let k = 0; k < at.reveals.length; k++) {
      const r = at.reveals[k];
      if (r.kind === 'grid') {
        G.grid[r.gridIndex].collected = true;
        G.grid[r.gridIndex].faceUp = false;
      } else if (r.owner !== pi) {
        stolenFrom.push(r.owner);
      }
    }
    G.players[pi].sets.push(target);
    clearRevealed(G);
    resetAttempt(G);

    G.lastOutcome = 'success';
    G.lastResolution = { type: 'success', player: pi, setValue: target, stolenFrom: stolenFrom };
    log(G, name(G, pi) + ' 完成了一组 ' + target + '！' + (stolenFrom.length ? '（抢走了对手的牌）' : ''));

    const reason = checkWin(G.players[pi]);
    if (reason) {
      G.phase = 'over'; G.winner = pi; G.winReason = reason;
      log(G, '🏆 ' + name(G, pi) + ' 获胜：' + reason);
      return G;
    }

    if (G.christmas && CHRISTMAS_VALUES[target]) {
      christmasPass(G);
      log(G, '🎄 圣诞快乐！所有人把手牌传给左边的玩家。');
    }

    advanceTurn(G);
    checkTermination(G);
    return G;
  }

  function resolveBust(G) {
    const at = G.attempt;
    for (let k = 0; k < at.reveals.length; k++) {
      const r = at.reveals[k];
      if (r.kind === 'grid') {
        G.grid[r.gridIndex].faceUp = false;
      } else {
        const owner = G.players[r.owner];
        owner.hand.push(r.value);
        sortHand(owner.hand);
      }
    }
    clearRevealed(G);
    resetAttempt(G);
    G.lastOutcome = 'bust';
    G.lastResolution = { type: 'bust', player: G.activePlayer };
    advanceTurn(G);
    checkTermination(G);
    return G;
  }

  function clearRevealed(G) { G.players.forEach(function (p) { p.revealed = []; }); }
  function resetAttempt(G) { G.attempt = { active: false, target: null, matched: 0, reveals: [] }; }

  function christmasPass(G) {
    const n = G.numPlayers;
    const snapshot = G.players.map(function (p) { return p.hand; });
    for (let i = 0; i < n; i++) {
      // player i gives their hand to the player on their left (i+1)
      G.players[(i + 1) % n].hand = snapshot[i];
    }
    G.players.forEach(function (p) { sortHand(p.hand); });
  }

  function advanceTurn(G) {
    G.activePlayer = (G.activePlayer + 1) % G.numPlayers;
    G.turnCount += 1;
  }

  // how many copies of value v are currently REACHABLE (grid + hand-end runs)
  function reachableForValue(G, v) {
    let n = 0;
    for (let i = 0; i < G.grid.length; i++) {
      const c = G.grid[i];
      if (!c.collected && !c.faceUp && c.value === v) n++;
    }
    for (let pi = 0; pi < G.numPlayers; pi++) {
      const h = G.players[pi].hand;
      if (!h.length) continue;
      if (h[0] === h[h.length - 1]) {            // whole hand is one value (sorted)
        if (h[0] === v) n += h.length;
      } else {                                    // min and max are distinct -> disjoint runs
        if (h[0] === v) { for (let i = 0; i < h.length && h[i] === v; i++) n++; }
        if (h[h.length - 1] === v) { for (let i = h.length - 1; i >= 0 && h[i] === v; i--) n++; }
      }
    }
    return n;
  }
  function isLocked(G) {
    for (let v = 1; v <= 12; v++) if (reachableForValue(G, v) >= 3) return false;
    return true;
  }
  // break a dead position: reshuffle all uncollected cards back into the same-sized hands/grid
  function reshuffleBoard(G) {
    const handCounts = G.players.map(function (p) { return p.hand.length; });
    const gridIdx = [];
    const pool = [];
    G.players.forEach(function (p) { while (p.hand.length) pool.push(p.hand.pop()); });
    for (let i = 0; i < G.grid.length; i++) {
      if (!G.grid[i].collected) { pool.push(G.grid[i].value); gridIdx.push(i); }
    }
    shuffle(pool, G.rng);
    let k = 0;
    for (let pi = 0; pi < G.numPlayers; pi++) {
      const h = [];
      for (let c = 0; c < handCounts[pi]; c++) h.push(pool[k++]);
      sortHand(h); G.players[pi].hand = h;
    }
    for (let g = 0; g < gridIdx.length; g++) {
      const slot = G.grid[gridIdx[g]];
      slot.value = pool[k++]; slot.faceUp = false; slot.collected = false;
    }
    G.reshuffles += 1;
    log(G, '🔄 出现僵局，自动重洗所有未收集的牌。(' + G.reshuffles + ')');
  }
  function checkTermination(G) {
    if (G.phase !== 'playing') return;
    if (legalReveals(G).length === 0) { endByRanking(G, '无牌可翻'); return; }
    if (G.turnCount > TURN_CAP) { endByRanking(G, '回合上限'); return; }
    let tries = 0;
    while (G.phase === 'playing' && isLocked(G)) {
      if (G.reshuffles >= 200) { endByRanking(G, '多次重洗仍无解'); return; }
      reshuffleBoard(G);
      if (++tries > 60) { endByRanking(G, '僵局'); return; }
    }
  }

  function endByRanking(G, why) {
    let best = 0;
    for (let i = 1; i < G.numPlayers; i++) {
      const a = G.players[i], b = G.players[best];
      const ax = a.sets.length, bx = b.sets.length;
      if (ax > bx || (ax === bx && pip(a) > pip(b))) best = i;
    }
    G.phase = 'over'; G.winner = best;
    G.winReason = '游戏结束（' + why + '）：' + name(G, best) + ' 组数最多';
    log(G, '🏁 ' + G.winReason);
  }
  function pip(p) { let s = 0; for (let i = 0; i < p.sets.length; i++) s += p.sets[i] * 3; return s; }

  // ---- a view for the UI / AI (hides other hands' contents) ---------------
  function view(G, seat) {
    return {
      numPlayers: G.numPlayers,
      activePlayer: G.activePlayer,
      phase: G.phase, winner: G.winner, winReason: G.winReason,
      christmas: G.christmas, turnCount: G.turnCount,
      attempt: { active: G.attempt.active, target: G.attempt.target, matched: G.attempt.matched, reveals: G.attempt.reveals.slice() },
      grid: G.grid.map(function (c) { return { faceUp: c.faceUp, collected: c.collected, value: c.faceUp ? c.value : null }; }),
      players: G.players.map(function (p, i) {
        return {
          id: p.id, name: p.name, isHuman: p.isHuman, isAI: p.isAI,
          difficulty: p.difficulty, personality: p.personality,
          handCount: p.hand.length,
          hand: (i === seat) ? p.hand.slice() : null,
          handMin: p.hand.length ? p.hand[0] : null,        // only meaningful for own seat in UI; null otherwise
          sets: p.sets.slice(),
          revealed: p.revealed.slice()
        };
      }),
      log: G.log.slice(-12)
    };
  }

  /* ==========================================================================
   * Move AI — heuristic, with memory of seen cards. Separate from chatter AI.
   * ========================================================================*/
  const AI = {
    newMemory: function (numPlayers) {
      return { grid: {}, ends: {} }; // grid[index]=value seen; ends[pi]={min,max}
    },
    // record what just got revealed (everyone watches public reveals)
    observe: function (mem, reveal) {
      if (!reveal) return;
      if (reveal.kind === 'grid') { mem.grid[reveal.gridIndex] = reveal.value; return; }
      if (!mem.ends[reveal.owner]) mem.ends[reveal.owner] = { min: null, max: null };
      const e = mem.ends[reveal.owner];
      if (reveal.end === 'smallest') e.min = reveal.value;
      else if (reveal.end === 'biggest') e.max = reveal.value;
      else { e.min = reveal.value; e.max = reveal.value; }
    },
    // an opponent's hand changed (steal / christmas) -> their end memory is stale
    forgetEnds: function (mem, pi) { if (mem.ends[pi]) mem.ends[pi] = { min: null, max: null }; },

    chooseReveal: function (G, mem, pi, difficulty) {
      const at = G.attempt;
      const legal = legalReveals(G);
      if (legal.length === 0) return null;
      const me = G.players[pi];
      const god = difficulty === 'god';
      const noise = god ? 0 : (difficulty === 'easy' ? 0.5 : (difficulty === 'medium' ? 0.15 : 0.03));

      function predict(mv) {
        if (god) return moveValue(G, mv);
        if (mv.kind === 'grid') {
          const c = G.grid[mv.gridIndex];
          if (c.faceUp) return c.value;
          return (mem.grid[mv.gridIndex] !== undefined) ? mem.grid[mv.gridIndex] : null;
        }
        if (mv.owner === pi) return moveValue(G, mv);
        const e = mem.ends[mv.owner];
        if (!e) return null;
        return mv.end === 'smallest' ? e.min : e.max;
      }
      function certainty(mv) {
        if (god) return 1;
        if (mv.kind === 'grid') return G.grid[mv.gridIndex].faceUp ? 1 : (mem.grid[mv.gridIndex] !== undefined ? 0.85 : 0);
        if (mv.owner === pi) return 1;
        const e = mem.ends[mv.owner];
        if (!e) return 0;
        return (mv.end === 'smallest' ? e.min : e.max) !== null ? 0.6 : 0;
      }

      // CONTINUING an attempt: must find another target-valued card
      if (at.active) {
        const T = at.target;
        const matches = legal.filter(function (mv) { return predict(mv) === T; });
        matches.sort(function (a, b) { return certainty(b) - certainty(a); });
        if (matches.length && G.rng() > noise) return matches[0];
        // forced + nothing known: gamble on an unseen grid card (informative bust), else random
        const unseen = legal.filter(function (mv) { return mv.kind === 'grid' && certainty(mv) === 0; });
        const pool = unseen.length ? unseen : legal;
        return pool[Math.floor(G.rng() * pool.length)];
      }

      // STARTING a turn: choose the best target value to chase.
      function endRun(hand, end) {
        if (!hand.length) return 0;
        if (end === 'smallest') { let v = hand[0], c = 0; for (let i = 0; i < hand.length && hand[i] === v; i++) c++; return c; }
        let v = hand[hand.length - 1], c = 0; for (let i = hand.length - 1; i >= 0 && hand[i] === v; i--) c++; return c;
      }
      const info = {};
      function bump(v, move, copies, conf) {
        if (v == null) return;
        let o = info[v]; if (!o) { o = { count: 0, conf: 0, move: move }; info[v] = o; }
        o.count += copies;
        if (conf > o.conf) { o.conf = conf; o.move = move; }
      }
      // grid: each face-down slot is one reachable copy
      for (let i = 0; i < G.grid.length; i++) {
        const c = G.grid[i];
        if (c.collected || c.faceUp) continue;
        const mv = { kind: 'grid', gridIndex: i };
        bump(predict(mv), mv, 1, certainty(mv));
      }
      // hands (own + opponents): a single end can yield a whole run via repeated peeling
      for (let pj = 0; pj < G.numPlayers; pj++) {
        const hp = G.players[pj].hand; if (!hp.length) continue;
        const knowRun = god || pj === pi;            // run length known only for own hand / god
        const sm = { kind: 'hand', owner: pj, end: 'smallest' };
        const sv = predict(sm);
        if (knowRun && hp[0] === hp[hp.length - 1]) {  // whole hand one value -> count once
          if (sv !== null) bump(sv, sm, hp.length, certainty(sm));
          continue;
        }
        if (sv !== null) bump(sv, sm, knowRun ? endRun(hp, 'smallest') : 1, certainty(sm));
        if (hp.length > 1) {
          const bg = { kind: 'hand', owner: pj, end: 'biggest' };
          const bv = predict(bg);
          if (bv !== null) bump(bv, bg, knowRun ? endRun(hp, 'biggest') : 1, certainty(bg));
        }
      }

      let best = null, bestScore = -1;
      Object.keys(info).forEach(function (vs) {
        const v = +vs, o = info[vs];
        const completable = o.count >= 3;          // can actually be finished this turn
        let score = o.conf * 3 + Math.min(3, o.count) * 1.5;
        if (completable) {
          score += 10;                             // strongly prefer a guaranteed completion
          if (winValue(me.sets.concat([v]))) score += 100;  // ...and a winning one most of all
          else if (v === 7) score += 4;
        } else if (winValue(me.sets.concat([v]))) {
          score += 4;                              // mild allure for a near-win gamble
        }
        score += G.rng() * (noise * 12);
        if (score > bestScore) { bestScore = score; best = { v: v, o: o }; }
      });

      // commit if we can locate >=2 copies (continue branch peels/gambles the rest); else probe
      if (best && best.o.count >= 2) return best.o.move;

      const unseen = legal.filter(function (mv) { return mv.kind === 'grid' && mem.grid[mv.gridIndex] === undefined; });
      if (unseen.length) return unseen[Math.floor(G.rng() * unseen.length)];
      // probe an opponent end we don't know yet (learn their min/max), else own end
      const unknownOpp = legal.filter(function (mv) { return mv.kind === 'hand' && mv.owner !== pi && certainty(mv) === 0; });
      if (unknownOpp.length) return unknownOpp[Math.floor(G.rng() * unknownOpp.length)];
      const mine = legal.filter(function (mv) { return mv.kind === 'hand' && mv.owner === pi; });
      const pool = mine.length ? mine : legal;
      return pool[Math.floor(G.rng() * pool.length)];
    }
  };

  const NanaEngine = {
    makeRng: makeRng, buildDeck: buildDeck, createGame: createGame,
    legalReveals: legalReveals, moveValue: moveValue, applyReveal: applyReveal,
    checkWin: checkWin, winValue: winValue, view: view,
    isLocked: isLocked, reachableForValue: reachableForValue,
    HAND_SIZE: HAND_SIZE, GRID_SIZE: GRID_SIZE, AI: AI
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = NanaEngine;
  root.NanaEngine = NanaEngine;
})(typeof window !== 'undefined' ? window : globalThis);
