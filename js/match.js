/**
 * Resolving user input ("35952021", "Priyanka Nutakki", "#12") to a player.
 *
 * Name order is not dependable on Chess-Results entry lists — the same person
 * may appear as "Singh S. Vikramjit" or "Vikramjit Singh S" — so matching walks
 * a ladder from exact to fuzzy and reports which rung it landed on. Anything
 * below a confident rung is returned as a suggestion rather than an answer,
 * because a silently wrong board number is worse than no answer.
 */

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

const tokensOf = (s) => normalizeName(s).split(' ').filter(Boolean);
const sortedKey = (s) => tokensOf(s).sort().join(' ');

/** Sørensen–Dice coefficient over character bigrams. */
function similarity(a, b) {
  const bigrams = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      set.set(g, (set.get(g) || 0) + 1);
    }
    return set;
  };
  const A = normalizeName(a).replace(/ /g, '');
  const B = normalizeName(b).replace(/ /g, '');
  if (!A.length || !B.length) return 0;
  if (A === B) return 1;
  const ga = bigrams(A);
  const gb = bigrams(B);
  let hits = 0;
  for (const [g, n] of ga) hits += Math.min(n, gb.get(g) || 0);
  return (2 * hits) / (A.length - 1 + B.length - 1);
}

/** Build lookup tables over the starting-rank player list. */
export function buildIndex(players) {
  const bySnr = new Map();
  const byAicf = new Map();
  const byFide = new Map();
  const byExact = new Map();
  const bySorted = new Map();

  const push = (map, key, p) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  };

  for (const p of players) {
    bySnr.set(p.snr, p);
    push(byAicf, p.aicfId, p);
    push(byFide, p.fideId && p.fideId !== '0' ? p.fideId : '', p);
    push(byExact, normalizeName(p.name), p);
    push(bySorted, sortedKey(p.name), p);
  }
  return { players, bySnr, byAicf, byFide, byExact, bySorted };
}

/** Split a textarea into individual queries. */
export function splitQueries(text) {
  return String(text || '')
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function result(status, extra) {
  return { status, player: null, candidates: [], via: '', ...extra };
}

/**
 * Resolve one query against the index.
 * @returns {{status:'ok'|'ambiguous'|'none', player:object|null,
 *            candidates:object[], via:string, approx?:boolean}}
 */
export function resolveQuery(query, index) {
  const q = query.trim();
  if (!q) return result('none');

  // Starting number, written as "#12"
  const hash = q.match(/^#\s*(\d+)$/);
  if (hash) {
    const p = index.bySnr.get(Number(hash[1]));
    return p ? result('ok', { player: p, via: 'starting no.' }) : result('none');
  }

  // Pure digits — an AICF ID, a FIDE ID, or a starting number for short values.
  if (/^\d+$/.test(q)) {
    for (const [map, via] of [[index.byAicf, 'AICF ID'], [index.byFide, 'FIDE ID']]) {
      const hits = map.get(q);
      if (hits && hits.length === 1) return result('ok', { player: hits[0], via });
      if (hits && hits.length > 1) return result('ambiguous', { candidates: hits, via });
    }
    if (q.length <= 4) {
      const p = index.bySnr.get(Number(q));
      if (p) return result('ok', { player: p, via: 'starting no.' });
    }
    return result('none');
  }

  // Name ladder, most confident first.
  const norm = normalizeName(q);
  const qTokens = tokensOf(q);

  for (const [map, key, via] of [
    [index.byExact, norm, 'name'],
    [index.bySorted, sortedKey(q), 'name (reordered)'],
  ]) {
    const hits = map.get(key);
    if (hits && hits.length === 1) return result('ok', { player: hits[0], via });
    if (hits && hits.length > 1) return result('ambiguous', { candidates: hits, via });
  }

  // Every query token present in the candidate — handles missing middle names
  // and initials, e.g. "Vikramjit Singh" -> "Singh S. Vikramjit".
  if (qTokens.length >= 2 || norm.length >= 5) {
    const subset = index.players.filter((p) => {
      const t = tokensOf(p.name);
      return qTokens.every((qt) => t.some((pt) => pt === qt || (qt.length >= 4 && pt.startsWith(qt))));
    });
    if (subset.length === 1) return result('ok', { player: subset[0], via: 'partial name' });
    if (subset.length > 1) return result('ambiguous', { candidates: subset, via: 'partial name' });

    const contains = index.players.filter((p) => normalizeName(p.name).includes(norm));
    if (contains.length === 1) return result('ok', { player: contains[0], via: 'partial name' });
    if (contains.length > 1) return result('ambiguous', { candidates: contains, via: 'partial name' });
  }

  // Fuzzy — only trusted when one candidate is clearly ahead of the rest.
  const scored = index.players
    .map((p) => ({ p, s: similarity(q, p.name) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);

  if (scored.length && scored[0].s >= 0.82 && (scored.length < 2 || scored[1].s < 0.7)) {
    return result('ok', { player: scored[0].p, via: 'closest name', approx: true });
  }
  return result('none', { candidates: scored.filter((x) => x.s >= 0.45).map((x) => x.p) });
}
