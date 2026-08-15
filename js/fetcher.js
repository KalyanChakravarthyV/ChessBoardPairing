/**
 * Fetching Chess-Results pages from a static site.
 *
 * chess-results.com sends no Access-Control-Allow-Origin header, so the browser
 * cannot read it directly — every request has to go through a CORS relay.
 * Public relays are rate-limited and the origin intermittently refuses
 * datacentre IPs (HTTP 520/522), so any single attempt is unreliable.
 *
 * Attempts are therefore raced in small parallel waves rather than tried one
 * after another: waiting out a 20s timeout five times over is the difference
 * between a two-second answer and a two-minute one. Each wave mixes different
 * relays and mirrors, and the whole thing is bounded by a wall-clock deadline.
 */

const PROXY_KEY = 'cbp.proxy';

/** Relay templates. `{url}` = percent-encoded target, `{raw}` = target as-is. */
const RELAYS = [
  { name: 'allorigins', tpl: 'https://api.allorigins.win/raw?url={url}' },
  { name: 'codetabs',   tpl: 'https://api.codetabs.com/v1/proxy?quest={url}' },
  { name: 'cors.lol',   tpl: 'https://api.cors.lol/?url={url}' },
  { name: 'cors.sh',    tpl: 'https://proxy.cors.sh/{raw}' },
  { name: 'corsproxy',  tpl: 'https://corsproxy.io/?url={url}' },
];

/** Chess-Results serves the same content from several mirrors. */
const MIRRORS = [
  's3.chess-results.com',
  's1.chess-results.com',
  's2.chess-results.com',
  'chess-results.com',
];

const ATTEMPT_TIMEOUT_MS = 20000;
const WAVE_SIZE = 4;
const DEADLINE_MS = 95000;

/**
 * Pairings are live data — an arbiter re-pairing a round moves board numbers.
 * Cached pages therefore expire quickly; without this a page fetched once was
 * reused for the lifetime of the tab, so a stale board number could survive
 * every action except an explicit Refresh.
 */
const MEMO_TTL_MS = 60_000;

const memo = new Map();

/** A user-supplied relay (e.g. their own Cloudflare Worker) takes priority. */
export function getCustomProxy() {
  try { return localStorage.getItem(PROXY_KEY) || ''; } catch { return ''; }
}

export function setCustomProxy(tpl) {
  try {
    if (tpl) localStorage.setItem(PROXY_KEY, tpl);
    else localStorage.removeItem(PROXY_KEY);
  } catch { /* private mode — ignore */ }
}

function relays() {
  const custom = getCustomProxy().trim();
  return custom ? [{ name: 'custom', tpl: custom }, ...RELAYS] : RELAYS;
}

function buildRelayUrl(tpl, target) {
  return tpl
    .replace('{url}', encodeURIComponent(target))
    .replace('{raw}', target);
}

/**
 * Build a Chess-Results page URL.
 * art=0 starting rank, art=2 pairings of a round.
 * zeilen=99999 defeats the default 100-row pagination.
 */
export function crUrl(host, tnr, params) {
  const qs = new URLSearchParams({ lan: '1', zeilen: '99999', ...params });
  return `https://${host}/tnr${tnr}.aspx?${qs}`;
}

/** A relay may answer 200 with its own error page — check it smells right. */
function looksLikeChessResults(text) {
  if (!text || text.length < 1500) return false;
  return /chess-results/i.test(text) && /<\/html>/i.test(text);
}

/**
 * Candidate attempts, interleaved so each wave spans different relays *and*
 * different mirrors — hitting one relay four times over just trips its
 * rate limiter.
 */
function candidates(tnr, params, stamp) {
  const list = relays();
  // Relays cache too. A throwaway parameter — ignored by Chess-Results — makes
  // the target look like a new resource so an explicit Refresh really is fresh.
  const query = stamp ? { ...params, _: stamp } : params;
  const out = [];
  for (let i = 0; i < list.length * MIRRORS.length; i++) {
    const relay = list[i % list.length];
    const host = MIRRORS[Math.floor(i / list.length) % MIRRORS.length];
    out.push({
      label: `${relay.name}/${host.split('.')[0]}`,
      url: buildRelayUrl(relay.tpl, crUrl(host, tnr, query)),
    });
  }
  return out;
}

async function attempt(url, signal) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!looksLikeChessResults(text)) throw new Error('unexpected response body');
    return text;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch one Chess-Results page as HTML text.
 *
 * @param {string}   tnr        tournament number, e.g. "1444215"
 * @param {object}   params     extra query params, e.g. { art: 2, rd: 3 }
 * @param {object}   [opts]
 * @param {function} [opts.onProgress] called with a human-readable attempt note
 * @param {boolean}  [opts.force]      ignore the cached copy
 * @param {boolean}  [opts.bust]       also defeat the relay's own cache
 * @returns {Promise<string>} raw HTML
 */
export async function fetchPage(tnr, params, opts = {}) {
  const { onProgress = () => {}, force = false, bust = false } = opts;
  const key = `${tnr}|${new URLSearchParams(params)}`;

  const hit = memo.get(key);
  if (!force && hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.html;

  const all = candidates(tnr, params, bust ? String(Date.now()) : null);
  const deadline = Date.now() + DEADLINE_MS;
  const errors = [];
  let done = 0;

  for (let i = 0; i < all.length; i += WAVE_SIZE) {
    if (Date.now() > deadline) break;

    const wave = all.slice(i, i + WAVE_SIZE);
    const ctrl = new AbortController();
    onProgress(`Contacting chess-results.com… (${done + 1}–${done + wave.length} of ${all.length})`);

    const tasks = wave.map((c) =>
      attempt(c.url, ctrl.signal).catch((err) => {
        errors.push(`${c.label}: ${err.message}`);
        throw err;
      })
    );

    try {
      const html = await Promise.any(tasks);
      ctrl.abort();               // stop the losers of the race
      memo.set(key, { html, at: Date.now() });
      return html;
    } catch {
      // Whole wave failed; fall through to the next one.
    }
    done += wave.length;
  }

  const err = new Error(
    'Could not reach chess-results.com through any public relay. ' +
    'The relays are rate-limited and the site sometimes blocks them — ' +
    'wait a moment and press Refresh, or add your own relay under Advanced.'
  );
  err.detail = errors.join(' · ');
  throw err;
}

/** Drop cached pages so the next fetch is live. */
export function clearCache() { memo.clear(); }
