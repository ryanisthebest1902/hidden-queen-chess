# Hidden Queen Chess

A chess variant where each player secretly designates one of their own
non-king pieces as a disguised second queen. It keeps its normal
appearance until it makes a move its disguise couldn't legally make — at
that instant it's revealed to both players for the rest of the game.

Play against a bot (Elo 250–3200, reasoning under uncertainty about your
hidden queen), locally against a friend on one device (pass-and-play), or
online against a friend on a different device anywhere.

## Playing locally

Just open `index.html` in a browser, or serve the folder with any static
file server. No build step, no dependencies for bot play or local
pass-and-play mode.

## Online play

Online play is server-authoritative: a Node/Socket.IO backend (in
[`server/`](server/)) runs the real rules engine and is the sole source of
truth for both players' moves and hidden-queen identities. Neither
player's browser ever learns the opponent's secret — the server never
sends a still-hidden piece's true type to the wrong viewer. Just click
"Play Online"; there's no per-player setup, the client (`server-netplay.js`)
connects straight to the deployed server.

The server also supports accounts, match history, Elo-based ratings and
matchmaking, reconnection after a dropped connection, and horizontal
scaling across multiple instances sharing one Redis-backed state store —
see [`server/`](server/) for the source if you want to run or deploy your
own instance.

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. In the repo's Settings → Pages, set the source to your default branch
   (root folder).
3. Once it publishes, your game is live at
   `https://<your-username>.github.io/<repo-name>/`.

This deploys only the static client. Online play talks to whatever server
URL is configured in `server-netplay.js` — deploy `server/` separately
(e.g. to Render) and point that constant at it.

## Project structure

| File | Purpose |
|---|---|
| `engine.js` | Rules engine: board state, legal moves, check/checkmate/draw detection, the hidden-queen reveal logic. The only source of truth for what's legal. Also exports `applyRemoteMove`, the disguise-replay trick a client uses to converge to a move it wasn't told the true identity behind. |
| `elo.js` | Bot roster (250–3200 Elo) and the search-config knobs (depth, temperature, blunder chance, eval layers, determinization samples) for each tier. |
| `bot.js` | The bot's search: minimax/alpha-beta/quiescence with a transposition table and null-move pruning, run across multiple sampled hypotheses (determinization) for which opponent piece might be the hidden queen. Never reads the human's true piece types before they're revealed. |
| `rating.js` | The player's local practice Elo rating and match history (bot games only; `localStorage`). |
| `server-netplay.js` | Online play client — connects to the server-authoritative backend over Socket.IO. Both colors are symmetric: neither ever applies its own move locally before the server confirms it. |
| `server/` | The server-authoritative backend: accounts, rooms, matchmaking, ratings, reconnection, and multi-instance scaling via Redis. |
| `ui.js` | All rendering and click handling, for all three modes. |
| `index.html` / `styles.css` | Markup and styling. |
| `tests.html` | An in-browser automated test suite (open it directly) covering the reveal rules, the no-cheat guarantee, the bot's Elo scaling, the rating math, and the online-sync convergence trick. |

## Credits

Move, capture, check and game-over sounds are from the Lichess "sfx" sound set
by [Enigmahack](https://github.com/Enigmahack), licensed AGPLv3+ — see
[`sounds/LICENSE.md`](sounds/LICENSE.md). The hidden-queen reveal chime is
synthesized in the browser.

## Running the tests

Open `tests.html` in a browser. No build step, no server required (though
serving it over `http://` rather than `file://` avoids a couple of browser
security quirks around CORS-free module loading — either works here since
nothing uses `fetch`/modules, but a quick `python -m http.server` or
similar in this folder is a fine habit).
