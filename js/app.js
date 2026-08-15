import { fetchPage, clearCache, getCustomProxy, setCustomProxy } from './fetcher.js';
import { parseTournamentNumber, parseStartingRank, parsePairings } from './parser.js';
import { buildIndex, splitQueries, resolveQuery } from './match.js';

const $ = (id) => document.getElementById(id);

const el = {
  url: $('urlInput'), load: $('loadBtn'),
  tBox: $('tournamentBox'), tName: $('tName'), tPlayers: $('tPlayers'), tId: $('tId'),
  round: $('roundSelect'), roundInfo: $('roundInfo'), refresh: $('refreshBtn'),
  autoChk: $('autoChk'), autoStatus: $('autoStatus'),
  players: $('playersInput'), find: $('findBtn'), clear: $('clearBtn'),
  status: $('status'),
  resultsCard: $('resultsCard'), body: $('resultsBody'), summary: $('summary'),
  unmatched: $('unmatched'),
  copy: $('copyBtn'), csv: $('csvBtn'),
  theme: $('themeBtn'),
  proxy: $('proxyInput'), proxySave: $('proxySaveBtn'), proxyStatus: $('proxyStatus'),
};

/* Auto-refresh backs off after every check that finds nothing new, so a page
 * left open all day settles into occasional polling instead of hammering the
 * relays. Pressing Refresh puts it back to the fast interval. */
const AUTO_BASE_MS = 30_000;
const AUTO_FACTOR = 1.6;
const AUTO_MAX_MS = 900_000;   // 15 minutes

const state = {
  tnr: null,
  tournament: null,   // { name, rounds, players }
  index: null,
  round: null,
  roundLabel: '',
  rows: [],           // rendered result rows
  busy: false,
  auto: {
    on: false,
    delay: AUTO_BASE_MS,
    dueAt: 0,
    timer: null,
    ticker: null,
    lastError: '',
    lastChange: '',
    missedWhileHidden: false,
  },
};

const DEFAULT_URL = 'https://s3.chess-results.com/tnr1444215.aspx?lan=1&art=0&SNode=S0&tno=1444215&zeilen=99999';

/* ── Status helpers ──────────────────────────────────────────────────── */

function setStatus(msg, kind = '', spinning = false) {
  if (!msg) { el.status.classList.add('hidden'); el.status.textContent = ''; return; }
  el.status.className = `status ${kind}`.trim();
  el.status.innerHTML = '';
  if (spinning) {
    const s = document.createElement('span');
    s.className = 'spinner';
    el.status.append(s);
  }
  el.status.append(document.createTextNode(msg));
}

function setBusy(on, { silent = false } = {}) {
  state.busy = on;
  if (!silent) for (const b of [el.load, el.find, el.refresh]) b.disabled = on;
  if (state.auto.on) renderAutoStatus();
}

/** Route progress messages to the main bar, or to the quiet line when polling. */
function reporter(silent) {
  return (msg, kind = '', spinning = false) => {
    if (!silent) setStatus(msg, kind, spinning);
    else if (kind === 'error') state.auto.lastError = msg;
  };
}

/* ── Loading ─────────────────────────────────────────────────────────── */

async function loadTournament({ force = false, silent = false } = {}) {
  const say = reporter(silent);
  const tnr = parseTournamentNumber(el.url.value);
  if (!tnr) {
    say('That does not look like a Chess-Results tournament link. Expected something like …/tnr1444215.aspx…', 'error');
    return false;
  }

  setBusy(true, { silent });
  say('Loading tournament…', '', true);
  try {
    const html = await fetchPage(tnr, { art: 0 }, {
      force,
      onProgress: (m) => say(m, '', true),
    });
    const parsed = parseStartingRank(html);

    if (!parsed.players.length) {
      say('Loaded the page but found no player list. Check the tournament number.', 'error');
      return false;
    }

    state.tnr = tnr;
    state.tournament = parsed;
    state.index = buildIndex(parsed.players);

    // renderRoundOptions drops a selected round that this tournament lacks.
    renderTournament();
    say('');
    state.auto.lastError = '';
    persist();
    return true;
  } catch (err) {
    say(err.message, 'error');
    if (err.detail) console.warn('Relay attempts:', err.detail);
    return false;
  } finally {
    setBusy(false, { silent });
  }
}

function renderTournament() {
  const t = state.tournament;
  el.tBox.classList.remove('hidden');
  el.tName.textContent = t.name || `Tournament ${state.tnr}`;
  el.tPlayers.textContent = `${t.players.length} players`;
  el.tId.textContent = `tnr${state.tnr}`;
  renderRoundOptions();
}

function renderRoundOptions() {
  const rounds = state.tournament.rounds;
  el.round.innerHTML = '';

  if (!rounds.length) {
    const o = document.createElement('option');
    o.textContent = 'No pairings published yet';
    o.value = '';
    el.round.append(o);
    el.round.disabled = true;
    state.round = null;
    el.roundInfo.textContent = 'Chess-Results has not published any round for this tournament yet.';
    return;
  }

  el.round.disabled = false;
  for (const r of rounds) {
    const o = document.createElement('option');
    o.value = String(r);
    o.textContent = `Round ${r}`;
    el.round.append(o);
  }
  // Default to the latest published round, or whatever was restored/selected.
  const wanted = rounds.includes(state.round) ? state.round : rounds[rounds.length - 1];
  state.round = wanted;
  el.round.value = String(wanted);
}

/* ── Lookup ──────────────────────────────────────────────────────────── */

/**
 * Look up the round, following a newly published one if the user was already
 * watching the latest. Split in two so the follow-up fetch starts only after
 * the first has fully released the busy flag.
 */
async function findPairings(opts = {}) {
  const followUp = await runPairings(opts);
  if (followUp) await runPairings({ ...opts, followed: true });
}

async function runPairings({ force = false, silent = false, followed = false } = {}) {
  const say = reporter(silent);
  const queries = splitQueries(el.players.value);
  if (!queries.length) {
    say('Add at least one AICF ID or name in step 2.', 'warn');
    if (!silent) el.players.focus();
    return false;
  }

  if (!state.tournament || parseTournamentNumber(el.url.value) !== state.tnr) {
    const loaded = await loadTournament({ force, silent });
    if (!loaded) return false;
  }

  if (!state.round) {
    say('No round has been published for this tournament yet.', 'warn');
    return false;
  }

  setBusy(true, { silent });
  say(`Loading round ${state.round} pairings…`, '', true);
  try {
    const html = await fetchPage(state.tnr, { art: 2, rd: state.round }, {
      force,
      onProgress: (m) => say(m, '', true),
    });
    const parsed = parsePairings(html);

    // The pairing page also carries the round navigation, so a round published
    // since the tournament was loaded shows up here first.
    if (mergeRounds(parsed.rounds) && !followed) return true;

    // A round can be listed before its pairings are actually out.
    if (!parsed.pairings.length) {
      state.rows = [];
      el.resultsCard.classList.add('hidden');
      say(`Round ${state.round} is listed but its pairings are not published yet.`, 'warn');
      return false;
    }

    state.roundLabel = parsed.roundLabel;
    el.roundInfo.textContent = parsed.roundLabel;

    render(buildRows(queries, parsed.pairings));
    say('');
    state.auto.lastError = '';
    persist();
  } catch (err) {
    say(err.message, 'error');
    if (err.detail) console.warn('Relay attempts:', err.detail);
  } finally {
    setBusy(false, { silent });
  }
  return false;
}

/**
 * Fold a freshly seen round list into the tournament.
 * @returns {boolean} true if the view should follow a newly published round.
 */
function mergeRounds(rounds) {
  if (!rounds.length || !state.tournament) return false;
  const known = state.tournament.rounds;
  if (rounds.join() === known.join()) return false;

  // Only follow the new round if the user was already watching the latest one;
  // someone deliberately looking at round 3 should stay on round 3.
  const wasOnLatest = state.round === known[known.length - 1];
  state.tournament.rounds = rounds;
  renderRoundOptions();

  const latest = rounds[rounds.length - 1];
  if (wasOnLatest && latest > state.round) {
    state.round = latest;
    el.round.value = String(latest);
    state.auto.lastChange = `Round ${latest} published`;
    return true;
  }
  return false;
}

/** Join resolved players to their pairing for the round. */
function buildRows(queries, pairings) {
  const bySnr = new Map();
  for (const p of pairings) {
    bySnr.set(p.white.snr, { pairing: p, colour: 'W' });
    if (p.black) bySnr.set(p.black.snr, { pairing: p, colour: 'B' });
  }

  const seen = new Set();
  const rows = [];
  let duplicates = 0;

  for (const q of queries) {
    const res = resolveQuery(q, state.index);

    if (res.status !== 'ok') {
      rows.push({ kind: res.status, query: q, candidates: res.candidates });
      continue;
    }
    // The same player can be named twice (e.g. by name and by AICF ID).
    if (seen.has(res.player.snr)) { duplicates++; continue; }
    seen.add(res.player.snr);

    const hit = bySnr.get(res.player.snr);
    if (!hit) {
      rows.push({ kind: 'nopair', query: q, player: res.player });
      continue;
    }

    const { pairing, colour } = hit;
    const opponent = colour === 'W' ? pairing.black : pairing.white;

    rows.push({
      kind: opponent ? 'pair' : 'bye',
      query: q,
      player: res.player,
      via: res.via,
      approx: res.approx || false,
      board: pairing.board,
      colour,
      opponent: opponent ? state.index.bySnr.get(opponent.snr) || opponent : null,
      note: pairing.note,
      result: pairing.result,
      unplayed: Boolean(pairing.unplayed),
      ownRes: colour === 'W' ? pairing.whiteRes : pairing.blackRes,
    });
  }
  rows.duplicates = duplicates;
  return rows;
}

/* ── Rendering ───────────────────────────────────────────────────────── */

function cell(row, label, node) {
  const td = document.createElement('td');
  td.dataset.label = label;
  if (node instanceof Node) td.append(node);
  else td.textContent = node;
  row.append(td);
  return td;
}

function playerCell(p, extra = '') {
  // One wrapper element so the name and its detail line stay stacked when the
  // table cell becomes a flex row on narrow screens.
  const frag = document.createElement('div');
  frag.className = 'pwrap';
  const name = document.createElement('div');
  name.className = 'pname';
  if (p.title) {
    const t = document.createElement('span');
    t.className = 'ptitle';
    t.textContent = p.title;
    name.append(t);
  }
  name.append(document.createTextNode(p.name));
  frag.append(name);

  const bits = [];
  if (p.rating && p.rating !== '0') bits.push(p.rating);
  if (p.aicfId) bits.push(p.aicfId);
  if (extra) bits.push(extra);
  if (bits.length) {
    const sub = document.createElement('div');
    sub.className = 'psub';
    sub.textContent = bits.join(' · ');
    frag.append(sub);
  }
  return frag;
}

function colourChip(colour) {
  const span = document.createElement('span');
  if (!colour) {
    span.className = 'colour na';
    span.textContent = '—';
    return span;
  }
  const white = colour === 'W';
  span.className = `colour ${white ? 'wh' : 'bl'}`;
  const piece = document.createElement('span');
  piece.className = 'piece';
  piece.textContent = white ? '♔' : '♚';
  span.append(piece, document.createTextNode(white ? 'Wh' : 'Bl'));
  return span;
}

/** Human wording for a forfeit, from this player's side. */
function forfeitLabel(ownRes) {
  if (ownRes === '+') return 'forfeit win';
  if (ownRes === '-') return 'forfeit loss';
  return 'forfeit';
}

/** The Result cell: a score, or an unmistakable "no game was played". */
function resultNode(r) {
  if (!r.unplayed || r.kind === 'bye') {
    return r.result && /\d|½/.test(r.result) ? r.result : '—';
  }
  const wrap = document.createElement('div');
  wrap.className = 'pwrap';
  const main = document.createElement('div');
  main.className = 'nogame';
  main.textContent = 'not played';
  const sub = document.createElement('div');
  sub.className = 'psub';
  sub.textContent = forfeitLabel(r.ownRes);
  wrap.append(main, sub);
  return wrap;
}

function render(rows) {
  state.rows = rows;
  el.body.innerHTML = '';
  el.unmatched.innerHTML = '';
  el.unmatched.classList.add('hidden');

  const found = rows.filter((r) => r.kind === 'pair' || r.kind === 'bye');
  const problems = rows.filter((r) => r.kind !== 'pair' && r.kind !== 'bye');

  for (const r of found) {
    const tr = document.createElement('tr');
    if (r.kind === 'bye' || r.unplayed) tr.className = 'row-nogame';

    cell(tr, 'Player', playerCell(r.player, r.approx ? `matched "${r.query}"` : ''));

    const boardTd = cell(tr, 'Board', r.board == null ? '—' : String(r.board));
    boardTd.className = r.board == null ? 'board none' : 'board';

    cell(tr, 'Colour', colourChip(r.kind === 'bye' ? null : r.colour));

    if (r.opponent) {
      cell(tr, 'Opponent', playerCell(r.opponent));
    } else {
      const td = cell(tr, 'Opponent', r.note || 'not paired');
      td.style.color = 'var(--warn)';
    }

    const res = cell(tr, 'Result', resultNode(r));
    res.className = 'result-cell';

    el.body.append(tr);
  }

  // Summary chips
  el.summary.innerHTML = '';
  const chips = [`Round ${state.round}`, `${found.length} found`];
  // Forfeits are excluded from the colour tally — nobody sat down to play them.
  const playing = found.filter((r) => r.kind === 'pair' && !r.unplayed);
  const whites = playing.filter((r) => r.colour === 'W').length;
  const blacks = playing.filter((r) => r.colour === 'B').length;
  if (whites || blacks) chips.push(`${whites} white · ${blacks} black`);
  const byes = found.filter((r) => r.kind === 'bye').length;
  if (byes) chips.push(`${byes} not paired`);
  const forfeits = found.filter((r) => r.kind === 'pair' && r.unplayed).length;
  if (forfeits) chips.push(`${forfeits} not played`);
  if (problems.length) chips.push(`${problems.length} unresolved`);
  if (rows.duplicates) chips.push(`${rows.duplicates} duplicate${rows.duplicates > 1 ? 's' : ''} skipped`);
  for (const c of chips) {
    const s = document.createElement('span');
    s.className = 'pill';
    s.textContent = c;
    el.summary.append(s);
  }

  if (problems.length) renderProblems(problems);
  el.resultsCard.classList.remove('hidden');
}

function renderProblems(problems) {
  el.unmatched.classList.remove('hidden');
  const h = document.createElement('h3');
  h.textContent = `${problems.length} entr${problems.length === 1 ? 'y' : 'ies'} not resolved`;
  const ul = document.createElement('ul');

  for (const p of problems) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = p.query;
    li.append(code);

    if (p.kind === 'nopair') {
      li.append(document.createTextNode(` — ${p.player.name} is in the tournament but has no pairing this round.`));
    } else if (p.kind === 'ambiguous') {
      li.append(document.createTextNode(' — matches several players: '));
      appendSuggestions(li, p.candidates);
    } else if (p.candidates && p.candidates.length) {
      li.append(document.createTextNode(' — no match. Did you mean '));
      appendSuggestions(li, p.candidates);
    } else {
      li.append(document.createTextNode(' — no match in the entry list.'));
    }
    ul.append(li);
  }
  el.unmatched.append(h, ul);
}

/** Clickable suggestions that rewrite the query line to a starting number. */
function appendSuggestions(li, candidates) {
  candidates.slice(0, 5).forEach((c, i) => {
    if (i) li.append(document.createTextNode(', '));
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'suggest';
    b.textContent = `${c.name} (#${c.snr})`;
    b.addEventListener('click', () => {
      el.players.value += `\n#${c.snr}`;
      el.players.focus();
    });
    li.append(b);
  });
  li.append(document.createTextNode('?'));
}

/* ── Auto-refresh ────────────────────────────────────────────────────── */

/** Compact signature of what is on screen, to tell a real change from a no-op. */
function fingerprint() {
  const rounds = state.tournament ? state.tournament.rounds.join(',') : '';
  const rows = state.rows
    .map((r) => (r.kind === 'pair' || r.kind === 'bye'
      ? `${r.player.snr}:${r.board}:${r.colour}:${r.opponent ? r.opponent.snr : ''}:${r.result}`
      : `${r.kind}:${r.query}`))
    .join('|');
  return `${state.round}#${rounds}#${rows}`;
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${m}m`;
}

function renderAutoStatus() {
  const a = state.auto;
  if (!a.on) { el.autoStatus.textContent = ''; el.autoStatus.className = 'auto-status'; return; }

  if (state.busy) {
    el.autoStatus.textContent = 'Checking for updates…';
    el.autoStatus.className = 'auto-status live';
    return;
  }

  const bits = [];
  let kind = '';
  if (a.lastError) { bits.push('Last check failed'); kind = 'warn'; }
  else if (a.lastChange) { bits.push(a.lastChange); kind = 'live'; }
  bits.push(`next check in ${fmtDuration(a.dueAt - Date.now())}`);
  bits.push(`interval ${fmtDuration(a.delay)}`);

  el.autoStatus.textContent = bits.join(' · ');
  el.autoStatus.className = `auto-status ${kind}`.trim();
}

function cancelAuto() {
  clearTimeout(state.auto.timer);
  clearInterval(state.auto.ticker);
  state.auto.timer = null;
  state.auto.ticker = null;
}

function scheduleAuto() {
  cancelAuto();
  const a = state.auto;
  if (!a.on || !state.tnr) { renderAutoStatus(); return; }

  a.dueAt = Date.now() + a.delay;
  a.timer = setTimeout(autoTick, a.delay);
  a.ticker = setInterval(renderAutoStatus, 1000);
  renderAutoStatus();
}

/** Back to the fast interval — used for anything the user did deliberately. */
function resetAuto() {
  state.auto.delay = AUTO_BASE_MS;
  state.auto.lastError = '';
  scheduleAuto();
}

async function autoTick() {
  const a = state.auto;
  if (!a.on) return;

  // Don't spend a relay attempt on a tab nobody is looking at.
  if (document.hidden) { a.missedWhileHidden = true; cancelAuto(); return; }
  if (state.busy) { scheduleAuto(); return; }

  const before = fingerprint();
  const hasPlayers = splitQueries(el.players.value).length > 0;

  if (!state.round || !hasPlayers) await loadTournament({ force: true, silent: true });
  if (state.round && hasPlayers) await findPairings({ force: true, silent: true });

  if (fingerprint() !== before) {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // mergeRounds may already have set a more specific message.
    if (!a.lastChange || !a.lastChange.startsWith('Round ')) a.lastChange = `Updated ${t}`;
  }

  // Grow the wait. Only the Refresh button (or another deliberate action)
  // brings it back down.
  a.delay = Math.min(Math.round(a.delay * AUTO_FACTOR), AUTO_MAX_MS);
  scheduleAuto();
}

function setAuto(on) {
  state.auto.on = on;
  el.autoChk.checked = on;
  try { localStorage.setItem('cbp.auto', on ? '1' : '0'); } catch { /* ignore */ }
  if (on) resetAuto();
  else { cancelAuto(); renderAutoStatus(); }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.auto.on) return;
  // Catch up on a check that came due while the tab was in the background.
  if (state.auto.missedWhileHidden) {
    state.auto.missedWhileHidden = false;
    autoTick();
  } else if (!state.auto.timer) {
    scheduleAuto();
  }
});

/* ── Export ──────────────────────────────────────────────────────────── */

function exportRows() {
  return state.rows
    .filter((r) => r.kind === 'pair' || r.kind === 'bye')
    .map((r) => ({
      player: r.player.name,
      aicf: r.player.aicfId || '',
      board: r.board == null ? '' : String(r.board),
      colour: r.kind === 'bye' ? '' : (r.colour === 'W' ? 'Wh' : 'Bl'),
      opponent: r.opponent ? r.opponent.name : (r.note || 'not paired'),
      result: r.kind === 'pair' && r.unplayed
        ? `not played (${forfeitLabel(r.ownRes)})`
        : (r.result || ''),
      unplayed: r.kind === 'pair' && r.unplayed,
    }));
}

function asText() {
  const head = `${state.tournament?.name || ''}\n${state.roundLabel || `Round ${state.round}`}\n`;
  const lines = exportRows().map((r) => {
    if (!r.colour) return `${r.player} — ${r.opponent}`;
    const line = `${r.player} — Board ${r.board}, ${r.colour} vs ${r.opponent}`;
    return r.unplayed ? `${line} — ${r.result}` : line;
  });
  return `${head}\n${lines.join('\n')}\n`;
}

function asCsv() {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const head = ['Player', 'AICF ID', 'Board', 'Colour', 'Opponent', 'Result'];
  const lines = [head.map(q).join(',')];
  for (const r of exportRows()) {
    lines.push([r.player, r.aicf, r.board, r.colour, r.opponent, r.result].map(q).join(','));
  }
  return lines.join('\n');
}

async function copyText() {
  const text = asText();
  try {
    await navigator.clipboard.writeText(text);
    flash(el.copy, 'Copied');
  } catch {
    // Clipboard API needs a secure context; fall back to a selection.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    flash(el.copy, 'Copied');
  }
}

function downloadCsv() {
  const blob = new Blob([asCsv()], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pairings-tnr${state.tnr}-r${state.round}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function flash(btn, msg) {
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = old; }, 1400);
}

/* ── Persistence ─────────────────────────────────────────────────────── */

function persist() {
  try {
    localStorage.setItem('cbp.url', el.url.value);
    localStorage.setItem('cbp.players', el.players.value);
  } catch { /* ignore */ }

  const params = new URLSearchParams();
  if (state.tnr) params.set('tnr', state.tnr);
  if (state.round) params.set('rd', String(state.round));
  history.replaceState(null, '', `${location.pathname}?${params}`);
}

function restore() {
  const params = new URLSearchParams(location.search);
  let url = params.get('tnr') ? `https://chess-results.com/tnr${params.get('tnr')}.aspx?lan=1&art=0` : '';
  try {
    url = url || localStorage.getItem('cbp.url') || '';
    el.players.value = localStorage.getItem('cbp.players') || '';
  } catch { /* ignore */ }
  el.url.value = url || DEFAULT_URL;
  if (params.get('rd')) state.round = Number(params.get('rd'));

  el.proxy.value = getCustomProxy();
  updateProxyStatus();

  try {
    const theme = localStorage.getItem('cbp.theme');
    if (theme) document.documentElement.dataset.theme = theme;
    state.auto.on = localStorage.getItem('cbp.auto') !== '0';
  } catch { state.auto.on = true; }
  el.autoChk.checked = state.auto.on;
}

function updateProxyStatus() {
  const v = getCustomProxy();
  el.proxyStatus.textContent = v ? `Custom relay active: ${v}` : 'Using the built-in public relays.';
}

/* ── Wiring ──────────────────────────────────────────────────────────── */

el.load.addEventListener('click', async () => {
  if (await loadTournament({ force: true })) resetAuto();
});

el.find.addEventListener('click', async () => {
  await findPairings();
  resetAuto();
});

el.refresh.addEventListener('click', async () => {
  clearCache();
  state.auto.lastChange = '';
  const before = fingerprint();
  if (splitQueries(el.players.value).length) await findPairings({ force: true });
  else await loadTournament({ force: true });
  if (fingerprint() !== before) {
    state.auto.lastChange = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  resetAuto();
});

el.round.addEventListener('change', async () => {
  state.round = Number(el.round.value) || null;
  state.auto.lastChange = '';
  if (el.players.value.trim()) await findPairings();
  resetAuto();
});

el.autoChk.addEventListener('change', () => setAuto(el.autoChk.checked));

el.clear.addEventListener('click', () => {
  el.players.value = '';
  el.resultsCard.classList.add('hidden');
  state.rows = [];
  setStatus('');
  persist();
  el.players.focus();
});

el.url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.load.click(); }
});

// Ctrl/Cmd+Enter from the textarea runs the lookup.
el.players.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); el.find.click(); }
});

el.copy.addEventListener('click', copyText);
el.csv.addEventListener('click', downloadCsv);

el.proxySave.addEventListener('click', () => {
  const v = el.proxy.value.trim();
  if (v && !v.includes('{url}') && !v.includes('{raw}')) {
    el.proxyStatus.textContent = 'The template needs a {url} placeholder for the target address.';
    return;
  }
  setCustomProxy(v);
  clearCache();
  updateProxyStatus();
});

el.theme.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('cbp.theme', next); } catch { /* ignore */ }
});

restore();
