/**
 * Parsers for Chess-Results HTML.
 *
 * Two pages matter:
 *   art=0  starting rank  — carries the AICF "ID" column and the starting number
 *   art=2  pairings       — board, White, Black, result, linked by starting number
 *
 * Both render into `table.CRs1`. Column order varies between tournaments, so
 * headers are matched by name rather than by position. Pairing rows for
 * unpaired players contain malformed cells (`<td & colsp & class="CRc">`), so
 * the players in a row are read from their `snr=` links instead of cell offsets.
 */

const domParser = new DOMParser();

const txt = (el) => (el ? el.textContent.replace(/\u00a0/g, ' ').trim() : '');

/** Strip the "*)" annotation Chess-Results appends to some names. */
const cleanName = (s) => s.replace(/\s*\*\)\s*$/, '').replace(/\s+/g, ' ').trim();

/**
 * Split a result cell into each player's token.
 * "1 - 0" and "½ - ½" are played games; "+" and "-" mark a forfeit, where the
 * pairing exists on paper but no game was played. "+ - -" is a White forfeit
 * win, "- - +" a Black one — note the middle "-" is the separator, not a score.
 */
function splitResult(s) {
  const m = String(s).match(/^\s*([01½+-])\s*-\s*([01½+-])\s*$/);
  return m ? { white: m[1], black: m[2] } : null;
}

/** Extract the tournament number from a pasted URL or a bare number. */
export function parseTournamentNumber(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d{3,9}$/.test(s)) return s;
  const fromPath = s.match(/tnr(\d+)\.aspx/i);
  if (fromPath) return fromPath[1];
  const fromQuery = s.match(/[?&](?:tno|tnr)=(\d+)/i);
  if (fromQuery) return fromQuery[1];
  return null;
}

function toDoc(html) {
  return domParser.parseFromString(html, 'text/html');
}

/** The main data table — the widest `table.CRs1` on the page. */
function mainTable(doc) {
  const tables = [...doc.querySelectorAll('table.CRs1')];
  if (!tables.length) return null;
  return tables.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
}

/** Map normalised header text -> column index. */
function headerIndex(table) {
  const head = table.rows[0];
  if (!head) return { map: {}, cells: [] };
  const cells = [...head.cells].map((c) => txt(c).toLowerCase().replace(/\.$/, ''));
  const map = {};
  cells.forEach((label, i) => {
    if (label && !(label in map)) map[label] = i;
  });
  return { map, cells };
}

/** Round numbers offered by the "Board Pairings" navigation row. */
function parseRounds(doc) {
  const rounds = new Set();

  for (const tr of doc.querySelectorAll('tr')) {
    const first = tr.cells && tr.cells[0];
    if (first && /^board pairings/i.test(txt(first))) {
      // The current round appears as plain bold text, the rest as links —
      // reading the whole row's text catches both.
      for (const m of txt(tr).matchAll(/Rd\.(\d+)/g)) rounds.add(Number(m[1]));
    }
  }
  if (!rounds.size) {
    for (const a of doc.querySelectorAll('a[href*="art=2"]')) {
      const m = a.getAttribute('href').match(/[?&]rd=(\d+)/i);
      if (m) rounds.add(Number(m[1]));
    }
  }
  return [...rounds].sort((a, b) => a - b);
}

/**
 * Chess-Results stamps every page with when the arbiter last uploaded.
 * Surfacing it is the only way a reader can tell a re-paired round from a
 * stale copy — board numbers move when a round is paired again.
 */
function parseLastUpdate(doc) {
  for (const p of doc.querySelectorAll('p.CRsmall')) {
    const m = txt(p).match(/Last update\s+([\d.]+\s+[\d:]+)/i);
    if (m) return m[1];
  }
  return '';
}

function parseTournamentName(doc) {
  const skip = /^(pairings|results|starting rank|final ranking|alphabetical|statistics|ranking|team)/i;
  for (const h of doc.querySelectorAll('h2')) {
    const t = txt(h);
    if (t && !skip.test(t)) return t;
  }
  const title = txt(doc.querySelector('title'));
  const parts = title.split(' - ');
  return parts.length > 1 ? parts.slice(1).join(' - ').trim() : title;
}

/**
 * Parse the starting-rank page (art=0).
 * @returns {{name:string, rounds:number[], players:Array}}
 */
export function parseStartingRank(html) {
  const doc = toDoc(html);
  const table = mainTable(doc);
  const out = {
    name: parseTournamentName(doc),
    rounds: parseRounds(doc),
    lastUpdate: parseLastUpdate(doc),
    players: [],
  };
  if (!table) return out;

  const { map, cells } = headerIndex(table);
  const iNo = map['no'] ?? 0;
  const iName = map['name'];
  if (iName === undefined) return out;

  // The unlabelled column just before "Name" holds the FIDE title.
  const iTitle = iName > 0 && cells[iName - 1] === '' ? iName - 1 : -1;
  const iAicf = map['id'] ?? -1;
  const iFide = map['fideid'] ?? -1;
  const iFed = map['fed'] ?? -1;
  const iRtg = map['rtg'] ?? -1;
  const iClub = map['club/city'] ?? map['club'] ?? -1;

  for (let r = 1; r < table.rows.length; r++) {
    const row = table.rows[r];
    const c = row.cells;
    if (!c || c.length <= iName) continue;

    const link = row.querySelector('a[href*="snr="]');
    const name = cleanName(txt(c[iName]));
    if (!name) continue;

    const snrMatch = link ? link.getAttribute('href').match(/[?&]snr=(\d+)/i) : null;
    const snr = snrMatch ? Number(snrMatch[1]) : Number(txt(c[iNo]));
    if (!Number.isFinite(snr)) continue;

    const aicf = iAicf >= 0 ? txt(c[iAicf]) : '';

    out.players.push({
      snr,
      name,
      title: iTitle >= 0 ? txt(c[iTitle]) : '',
      // Chess-Results writes "0" for players with no AICF ID on file.
      aicfId: aicf && aicf !== '0' ? aicf : '',
      fideId: iFide >= 0 ? txt(c[iFide]) : '',
      fed: iFed >= 0 ? txt(c[iFed]) : '',
      rating: iRtg >= 0 ? txt(c[iRtg]) : '',
      club: iClub >= 0 ? txt(c[iClub]) : '',
    });
  }
  return out;
}

/**
 * Parse a pairings page (art=2&rd=N).
 * @returns {{roundLabel:string, rounds:number[], pairings:Array, published:boolean}}
 */
export function parsePairings(html) {
  const doc = toDoc(html);
  const out = {
    roundLabel: '',
    rounds: parseRounds(doc),
    lastUpdate: parseLastUpdate(doc),
    pairings: [],
    published: false,
  };

  for (const h of doc.querySelectorAll('h3')) {
    const t = txt(h);
    if (/^round\b/i.test(t)) { out.roundLabel = t; break; }
  }

  const table = mainTable(doc);
  if (!table) return out;

  const { map } = headerIndex(table);
  const iBoard = map['bo'] ?? 0;
  const iResult = map['result'] ?? -1;
  if (map['white'] === undefined && map['bo'] === undefined) return out;
  out.published = true;

  for (let r = 1; r < table.rows.length; r++) {
    const row = table.rows[r];
    if (!row.cells.length) continue;

    // Player links carry `snr=`; the PGN link does not, so this yields
    // exactly [white] or [white, black].
    const links = [...row.querySelectorAll('a[href*="snr="]')];
    if (!links.length) continue;

    const asPlayer = (a) => ({
      snr: Number(a.getAttribute('href').match(/[?&]snr=(\d+)/i)[1]),
      name: cleanName(txt(a)),
    });

    const board = Number(txt(row.cells[iBoard]));
    const result = iResult >= 0 && row.cells[iResult] ? txt(row.cells[iResult]) : '';

    if (links.length >= 2) {
      const parts = splitResult(result);
      out.pairings.push({
        board: Number.isFinite(board) ? board : null,
        white: asPlayer(links[0]),
        black: asPlayer(links[1]),
        result,
        whiteRes: parts ? parts.white : '',
        blackRes: parts ? parts.black : '',
        // A forfeit still occupies a board on the pairing list, but nobody
        // played it — reporting it as a normal assignment is misleading.
        unplayed: parts ? /[+-]/.test(parts.white + parts.black) : false,
        note: '',
      });
    } else {
      // Unpaired / bye. Read the note from the cells after the player's own,
      // taking the first that contains letters — scanning for "½" instead would
      // match the points column ("5½") long before reaching "not paired".
      const cells = [...row.cells];
      const afterPlayer = cells.slice(cells.findIndex((c) => c.contains(links[0])) + 1);
      const note = afterPlayer.map(txt).find((t) => /[a-z]/i.test(t)) || 'not paired';
      out.pairings.push({
        board: null,
        white: asPlayer(links[0]),
        black: null,
        result: '',
        whiteRes: '',
        blackRes: '',
        unplayed: true,
        note,
      });
    }
  }
  return out;
}
