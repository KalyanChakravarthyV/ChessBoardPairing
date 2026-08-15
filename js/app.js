import { fetchPage, clearCache, getCustomProxy, setCustomProxy } from './fetcher.js';
import { parseTournamentNumber, parseStartingRank, parsePairings } from './parser.js';
import { buildIndex, splitQueries, resolveQuery } from './match.js';

const $ = (id) => document.getElementById(id);

const el = {
  url: $('urlInput'), load: $('loadBtn'),
  tBox: $('tournamentBox'), tName: $('tName'), tPlayers: $('tPlayers'), tId: $('tId'),
  round: $('roundSelect'), roundInfo: $('roundInfo'), refresh: $('refreshBtn'),
  players: $('playersInput'), find: $('findBtn'), clear: $('clearBtn'),
  status: $('status'),
  resultsCard: $('resultsCard'), body: $('resultsBody'), summary: $('summary'),
  unmatched: $('unmatched'),
  copy: $('copyBtn'), csv: $('csvBtn'),
  theme: $('themeBtn'),
  proxy: $('proxyInput'), proxySave: $('proxySaveBtn'), proxyStatus: $('proxyStatus'),
};

const state = {
  tnr: null,
  tournament: null,   // { name, rounds, players }
  index: null,
  round: null,
  roundLabel: '',
  rows: [],           // rendered result rows
};

const DEFAULT_URL = 'https://s3.chess-results.com/tnr1444215.aspx?lan=1&art=0&SNode=S0&tno=1444215&zeilen=99999';

/* ── Status helpers ──────────────────────────────────────────────────── */

function setStatus(msg, kind = '', busy = false) {
  if (!msg) { el.status.classList.add('hidden'); el.status.textContent = ''; return; }
  el.status.className = `status ${kind}`.trim();
  el.status.innerHTML = '';
  if (busy) {
    const s = document.createElement('span');
    s.className = 'spinner';
    el.status.append(s);
  }
  el.status.append(document.createTextNode(msg));
}

function busy(on) {
  for (const b of [el.load, el.find, el.refresh]) b.disabled = on;
}

/* ── Loading ─────────────────────────────────────────────────────────── */

async function loadTournament({ force = false } = {}) {
  const tnr = parseTournamentNumber(el.url.value);
  if (!tnr) {
    setStatus('That does not look like a Chess-Results tournament link. Expected something like …/tnr1444215.aspx…', 'error');
    return false;
  }

  busy(true);
  setStatus('Loading tournament…', '', true);
  try {
    const html = await fetchPage(tnr, { art: 0 }, {
      force,
      onProgress: (m) => setStatus(m, '', true),
    });
    const parsed = parseStartingRank(html);

    if (!parsed.players.length) {
      setStatus('Loaded the page but found no player list. Check the tournament number.', 'error');
      return false;
    }

    state.tnr = tnr;
    state.tournament = parsed;
    state.index = buildIndex(parsed.players);

    renderTournament();
    setStatus('');
    persist();
    return true;
  } catch (err) {
    setStatus(err.message, 'error');
    if (err.detail) console.warn('Relay attempts:', err.detail);
    return false;
  } finally {
    busy(false);
  }
}

function renderTournament() {
  const t = state.tournament;
  el.tBox.classList.remove('hidden');
  el.tName.textContent = t.name || `Tournament ${state.tnr}`;
  el.tPlayers.textContent = `${t.players.length} players`;
  el.tId.textContent = `tnr${state.tnr}`;

  const rounds = t.rounds;
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
  // Default to the latest published round, or whatever was restored from the URL.
  const wanted = rounds.includes(state.round) ? state.round : rounds[rounds.length - 1];
  state.round = wanted;
  el.round.value = String(wanted);
  el.roundInfo.textContent = '';
}

/* ── Lookup ──────────────────────────────────────────────────────────── */

async function findPairings({ force = false } = {}) {
  const queries = splitQueries(el.players.value);
  if (!queries.length) {
    setStatus('Add at least one AICF ID or name in step 2.', 'warn');
    el.players.focus();
    return;
  }

  if (!state.tournament || parseTournamentNumber(el.url.value) !== state.tnr) {
    const ok = await loadTournament({ force });
    if (!ok) return;
  }

  if (!state.round) {
    setStatus('No round has been published for this tournament yet.', 'warn');
    return;
  }

  busy(true);
  setStatus(`Loading round ${state.round} pairings…`, '', true);
  try {
    const html = await fetchPage(state.tnr, { art: 2, rd: state.round }, {
      force,
      onProgress: (m) => setStatus(m, '', true),
    });
    const parsed = parsePairings(html);

    // A round can be listed before its pairings are actually out.
    if (!parsed.pairings.length) {
      state.rows = [];
      el.resultsCard.classList.add('hidden');
      setStatus(`Round ${state.round} is listed but its pairings are not published yet.`, 'warn');
      return;
    }

    state.roundLabel = parsed.roundLabel;
    el.roundInfo.textContent = parsed.roundLabel;

    render(buildRows(queries, parsed.pairings));
    setStatus('');
    persist();
  } catch (err) {
    setStatus(err.message, 'error');
    if (err.detail) console.warn('Relay attempts:', err.detail);
  } finally {
    busy(false);
  }
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

function render(rows) {
  state.rows = rows;
  el.body.innerHTML = '';
  el.unmatched.innerHTML = '';
  el.unmatched.classList.add('hidden');

  const found = rows.filter((r) => r.kind === 'pair' || r.kind === 'bye');
  const problems = rows.filter((r) => r.kind !== 'pair' && r.kind !== 'bye');

  for (const r of found) {
    const tr = document.createElement('tr');
    if (r.kind === 'bye') tr.className = 'row-bye';

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

    const res = cell(tr, 'Result', r.result && /\d|½/.test(r.result) ? r.result : '—');
    res.className = 'result-cell';

    el.body.append(tr);
  }

  // Summary chips
  el.summary.innerHTML = '';
  const chips = [`Round ${state.round}`, `${found.length} found`];
  const whites = found.filter((r) => r.kind === 'pair' && r.colour === 'W').length;
  const blacks = found.filter((r) => r.kind === 'pair' && r.colour === 'B').length;
  if (whites || blacks) chips.push(`${whites} white · ${blacks} black`);
  const byes = found.filter((r) => r.kind === 'bye').length;
  if (byes) chips.push(`${byes} not paired`);
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
  if (found.length) el.resultsCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
      result: r.result || '',
    }));
}

function asText() {
  const head = `${state.tournament?.name || ''}\n${state.roundLabel || `Round ${state.round}`}\n`;
  const lines = exportRows().map((r) =>
    r.colour
      ? `${r.player} — Board ${r.board}, ${r.colour} vs ${r.opponent}`
      : `${r.player} — ${r.opponent}`
  );
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
  } catch { /* ignore */ }
}

function updateProxyStatus() {
  const v = getCustomProxy();
  el.proxyStatus.textContent = v ? `Custom relay active: ${v}` : 'Using the built-in public relays.';
}

/* ── Wiring ──────────────────────────────────────────────────────────── */

el.load.addEventListener('click', () => loadTournament({ force: true }));
el.find.addEventListener('click', () => findPairings());
el.refresh.addEventListener('click', () => { clearCache(); findPairings({ force: true }); });

el.round.addEventListener('change', () => {
  state.round = Number(el.round.value) || null;
  if (el.players.value.trim()) findPairings();
});

el.clear.addEventListener('click', () => {
  el.players.value = '';
  el.resultsCard.classList.add('hidden');
  setStatus('');
  persist();
  el.players.focus();
});

el.url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); loadTournament({ force: true }); }
});

// Ctrl/Cmd+Enter from the textarea runs the lookup.
el.players.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); findPairings(); }
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
