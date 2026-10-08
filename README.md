# Call It

A phone-friendly tennis site. A Netlify function reads game-handicap, total-games, first-set, set and
player-games lines from the Pinnwire feed, strips the margin, fits the two players' serve strengths that
reproduce those lines, and prices every pick from that one fitted match: game handicaps, set handicaps, total games, first-set and second-set totals, each player's own games
(over and under) and the winner. The page lets you choose among them with an odds slider.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole site (cards, bet slip, rollover, accumulators, tracker). |
| `netlify/functions/compute-odds.js` | The model and the API the page calls (server version 5). |
| `netlify.toml` | Netlify settings: publish folder, functions folder, Node 20. |
| `package.json` | Installs `@netlify/blobs` (stored fits and ratings). `npm test` runs the checks. |
| `tests/roundtrip.js` | Builds prices from a known match and checks the model recovers it. |
| `tests/check-engine.js` | Point-by-point simulation checked against the engine's tiebreak, set and match chances. |
| `.gitignore` | Keeps keys, `.env` and `node_modules` out of the repo. |

## Setup

1. Push these files to GitHub and connect the repo in Netlify.
2. Netlify > Site configuration > Environment variables: add `TENNIS_FEED_TOKEN` (or `PINNWIRE_KEY`) and tick
   "Contains secret values". The key must never be in the repo or the page.
3. Deploy with "Clear cache and deploy site" so `@netlify/blobs` installs.

## Endpoints

- `/.netlify/functions/compute-odds`: the matches (cached 20 minutes).
- `/.netlify/functions/compute-odds?view=ratings`: market-implied player ratings from stored fits
  (add `&refresh=1` to rebuild). Needs about 20 stored matches.

## Not built yet

Results capture and calibration, a shared form shock and three-set correction (needs real match files),
best-of-five for men's Slams (currently skipped), and a page box to enter scores.

Not betting advice.
