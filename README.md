# Board Finder

Give it a Chess-Results tournament link and a list of your players — it tells you
each player's **board number**, **colour (Wh / Bl)** and **opponent** for a round.

Built for coaches and academies who need to tell twenty students where to sit,
without scrolling a 200-board pairing list on a phone.

No build step, no backend, no dependencies — plain ES modules, deployable to
GitHub Pages as-is.

---

## Using it

1. **Tournament** — paste any Chess-Results page of the event. Only the
   tournament number matters, so all of these work:

   ```
   https://s3.chess-results.com/tnr1444215.aspx?lan=1&art=0&SNode=S0&tno=1444215&zeilen=99999
   https://chess-results.com/tnr1444215.aspx
   1444215
   ```

2. **Your players** — one entry per line (commas and semicolons also split).
   Each line can be:

   | Input | Example |
   | --- | --- |
   | AICF ID | `35952021` |
   | FIDE ID | `5000017` |
   | Name | `Magnus Carlsen` |
   | Name, any order | `Carlsen Magnus` |
   | Partial name | `Anand` |
   | Starting number | `#12` |

3. **Find pairings** — pick the round from the dropdown (it defaults to the
   latest published one) and read off the board, colour and opponent.
   **Copy** puts a plain-text list on the clipboard; **CSV** downloads a
   spreadsheet.

### Auto-refresh

Leave the page open during an event and it keeps checking for you. This is the
point of the feature: you open it before round 1 is out, and it tells you the
boards when they appear.

The wait grows after every check that finds nothing new — 30s, 48s, 77s, 2m,
… up to a 15-minute ceiling — so a page left open all day settles into
occasional polling instead of hammering the relays. The status line under the
round always says what it is doing:

```
next check in 48s · interval 48s
Round 1 published · next check in 30s · interval 30s
Last check failed · next check in 2m 03s · interval 2m 03s
```

**Pressing Refresh puts the interval back to 30 seconds.** So does loading a
tournament, running a lookup, or changing round — anything you did on purpose.
Nothing else resets it; the backoff keeps growing on its own.

Two more behaviours worth knowing:

- **It follows a new round.** If a later round is published while you are
  watching the latest one, the app switches to it and says `Round N published`.
  If you have deliberately selected an *older* round, it leaves you there.
- **It pauses on a hidden tab** and checks once when you come back, rather than
  spending relay attempts on a window nobody is looking at.

The toggle is remembered per browser. Turn it off if you would rather refresh
by hand.

The tournament link, your player list and the theme are remembered in the
browser. The address bar carries `?tnr=…&rd=…`, so a round is bookmarkable and
shareable.

### Matching rules

Entry lists spell names inconsistently, so lookup walks from exact to fuzzy and
tells you which rung it used. Anything it is not confident about is reported as
a **suggestion** rather than an answer — a wrong board number is worse than no
board number. Unresolved entries are listed under the table with clickable
"did you mean…" candidates that append the right starting number to your list.

Players with no AICF ID on file appear as `0` on Chess-Results; those are
treated as "no ID", so a literal `0` never matches anyone.

---

## Deploying to GitHub Pages

The repository root *is* the site. Push it, then:

**Option A — deploy from a branch (simplest)**

Settings → Pages → Source: *Deploy from a branch* → branch `main`, folder `/ (root)`.

**Option B — GitHub Actions**

Settings → Pages → Source: *GitHub Actions*. The included
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) publishes the
root on every push to `main`.

Either way the site lands at `https://<user>.github.io/<repo>/`.

### Running locally

ES modules need a real server — opening `index.html` from disk will not work.

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

---

## The CORS caveat — read this if lookups fail

Chess-Results sends no `Access-Control-Allow-Origin` header, so a browser on
another domain cannot read it directly. A static GitHub Pages site has no
backend, so requests are relayed through public CORS proxies.

Those proxies are rate-limited, and Chess-Results intermittently refuses
datacentre IPs (HTTP 520/522). The app compensates by rotating over five relays
and four Chess-Results mirrors (`s1`–`s3` and the main host), retrying in two
passes — up to 50 attempts. In practice one gets through, but at busy times
every relay can fail at once. Waiting a minute and pressing **Refresh** usually
clears it.

**For anything you depend on, run your own relay.** [`worker/`](worker/) is a
complete Cloudflare Worker that does the job; the free tier is far more than
enough. Measured against the same page, it returned in **1.2s cold and 5ms
cached**, where public relays took 12–40s or failed outright.

```sh
cd worker
npx wrangler deploy      # first run opens a browser to log in to Cloudflare
```

Then paste the URL it prints into **Advanced → network settings**, with
`?url={url}` on the end:

```
https://chess-results-relay.<your-subdomain>.workers.dev/?url={url}
```

`{url}` is replaced with the percent-encoded target (`{raw}` for unencoded).
The setting is stored in your browser and takes priority over the public relays.

The Worker only forwards to `chess-results.com` and its mirrors — without that
allowlist it would be an open proxy for the whole internet. Once it works, set
`ALLOWED_ORIGIN` in [`worker/wrangler.toml`](worker/wrangler.toml) to your own
Pages origin so other sites cannot use it either. It edge-caches for 30s, which
also shields Chess-Results from the auto-refresh polling.

---

## How it works

| File | Role |
| --- | --- |
| [`js/fetcher.js`](js/fetcher.js) | Relay × mirror rotation, parallel races, response validation, in-memory cache |
| [`js/parser.js`](js/parser.js) | Turns Chess-Results HTML into players and pairings |
| [`js/match.js`](js/match.js) | Resolves IDs and names to a player |
| [`js/app.js`](js/app.js) | State, rendering, auto-refresh, export |
| [`worker/`](worker/) | Optional Cloudflare Worker relay |

Two Chess-Results pages are read:

- `art=0` — the **starting rank**, which carries the AICF `ID` column and each
  player's starting number.
- `art=2&rd=N` — the **pairings** for a round, which reference players by
  starting number.

Joining the two on the starting number is what turns an AICF ID into a board.

Two details make the parsing robust: column order varies between tournaments, so
headers are matched by name rather than position; and rows for unpaired players
contain malformed cells (`<td & colsp & class="CRc">`), so the two players in a
row are read from their `snr=` links instead of cell offsets. A round listed in
the navigation but not yet published is reported as such rather than as an
empty result.

---

## Notes

Reads only public Chess-Results pages. Nothing is sent to a server that this
project controls — the player list never leaves the browser, apart from the
tournament URL that necessarily passes through whichever relay is in use.
