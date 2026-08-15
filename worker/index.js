/**
 * CORS relay for Chess-Results, as a Cloudflare Worker.
 *
 * Board Finder is a static site, so it cannot read chess-results.com directly —
 * that host sends no Access-Control-Allow-Origin header. The public relays the
 * app falls back on are rate-limited and are frequently refused by the origin.
 * Deploying this removes both problems.
 *
 *   GET /?url=<percent-encoded chess-results URL>
 *
 * Then paste `https://<your-worker>.workers.dev/?url={url}` into
 * Advanced -> network settings in the app.
 */

/** Only chess-results.com and its mirrors. Without this the Worker is an open proxy. */
const ALLOWED_HOST = /^([a-z0-9-]+\.)?chess-results\.com$/i;

/** Edge-cache window. Pairings change on the order of minutes, not seconds. */
const CACHE_SECONDS = 30;

export default {
  async fetch(request, env, ctx) {
    // Set ALLOWED_ORIGIN to your Pages origin to stop other sites using this.
    const allowOrigin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'GET') {
      return new Response('method not allowed', { status: 405, headers: cors });
    }

    const raw = new URL(request.url).searchParams.get('url');
    if (!raw) {
      return new Response('missing ?url=', { status: 400, headers: cors });
    }

    let target;
    try {
      target = new URL(raw);
    } catch {
      return new Response('malformed url', { status: 400, headers: cors });
    }

    if (target.protocol !== 'https:' || !ALLOWED_HOST.test(target.hostname)) {
      return new Response('target not allowed', { status: 403, headers: cors });
    }

    const cache = caches.default;
    const cacheKey = new Request(target.toString(), { method: 'GET' });

    let cached = await cache.match(cacheKey);
    if (!cached) {
      let upstream;
      try {
        upstream = await fetch(target.toString(), {
          headers: {
            // Chess-Results is unhappy with header-less datacentre requests.
            'User-Agent': 'Mozilla/5.0 (compatible; BoardFinder/1.0)',
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en',
          },
          cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
        });
      } catch (err) {
        return new Response(`upstream unreachable: ${err.message}`, { status: 502, headers: cors });
      }

      cached = new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') || 'text/html; charset=utf-8',
          'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
        },
      });

      if (upstream.ok) ctx.waitUntil(cache.put(cacheKey, cached.clone()));
    }

    const out = new Response(cached.body, cached);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
