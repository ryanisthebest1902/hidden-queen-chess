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

## Setting up online play

Online play needs a free Firebase Realtime Database project (about 5
minutes, one-time). Full instructions are in
[`firebase-config.js`](firebase-config.js) — open that file and follow the
steps at the top, then fill in your project's config values in the same
file.

Until you do this, "Play Online" will show a message pointing here instead
of connecting.

**Note on secrecy over the network:** since this ships as static files
with no backend server, the player who *hosts* a game runs the
authoritative rules engine — the same trust model as a local pass-and-play
game, just extended over a network connection. Your opponent's browser
never receives your hidden queen's identity, and vice versa when you're
the guest — but the host's own browser memory does technically hold both
players' secrets to referee the game. This is disclosed, not hidden: don't
host high-stakes games against someone you don't trust not to open
devtools.

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. In the repo's Settings → Pages, set the source to your default branch
   (root folder).
3. Once it publishes, your game is live at
   `https://<your-username>.github.io/<repo-name>/`.
4. Fill in `firebase-config.js` (see above) either before or after
   deploying — online play works as soon as real config values are live on
   the deployed site, no rebuild needed.

## Project structure

| File | Purpose |
|---|---|
| `engine.js` | Rules engine: board state, legal moves, check/checkmate/draw detection, the hidden-queen reveal logic. The only source of truth for what's legal. |
| `elo.js` | Bot roster (250–3200 Elo) and the search-config knobs (depth, temperature, blunder chance, eval layers, determinization samples) for each tier. |
| `bot.js` | The bot's search: minimax/alpha-beta/quiescence with a transposition table and null-move pruning, run across multiple sampled hypotheses (determinization) for which opponent piece might be the hidden queen. Never reads the human's true piece types before they're revealed. |
| `rating.js` | The player's local practice Elo rating and match history (bot games only; `localStorage`). |
| `netplay.js` | Online play over Firebase Realtime Database — room hosting/joining and the host-authoritative move sync protocol. |
| `ui.js` | All rendering and click handling, for all three modes. |
| `index.html` / `styles.css` | Markup and styling. |
| `tests.html` | An in-browser automated test suite (open it directly) covering the reveal rules, the no-cheat guarantee, the bot's Elo scaling, the rating math, and the online-sync convergence trick. |

## Running the tests

Open `tests.html` in a browser. No build step, no server required (though
serving it over `http://` rather than `file://` avoids a couple of browser
security quirks around CORS-free module loading — either works here since
nothing uses `fetch`/modules, but a quick `python -m http.server` or
similar in this folder is a fine habit).
