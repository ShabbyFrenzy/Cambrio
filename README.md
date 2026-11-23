# Cambrio Online

Play the card game Cambrio in the browser with friends (private rooms) or random players (quick play).

- **Stack:** Node.js + Express + Socket.IO. Plain HTML/CSS/JS in `public/`, no build step.
- **State:** rooms live in server memory. A restart clears open rooms (fine for a first version).

## Run it locally

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Open two browser windows (or one normal and one private window) to play against yourself.

## Files

| Path | What it does |
| --- | --- |
| `server/game.js` | Rules engine: deal, turns, powers, sticking, Cambrio, scoring. No networking. |
| `server/rooms.js` | Room codes, joining, hosts, starting rounds, running totals. |
| `server/index.js` | Express + Socket.IO wiring, reconnects, away-player timeouts. |
| `server/matchmaking.js` | Quick play queue (random players). |
| `public/index.html`, `app.js`, `style.css` | Home, lobby and game table. |
| `public/quickplay.html` | Quick play waiting page. |

## House rules built in

| Card | Value | Power (only when drawn from the deck and discarded) |
| --- | --- | --- |
| Joker | 0 | none |
| Red King | −1 | none |
| Ace | 1 | none |
| 2–6 | face value | none |
| 7, 8 | face value | look at one of your own cards |
| 9, 10 | face value | look at another player's card |
| J, Q | 11, 12 | swap any 2 cards, blind |
| Black King | 13 | look at any 2 cards, then you may swap any 2 |

## Table rules

- You can only draw from the deck, never from the discard pile.
- Sticking: anyone can stick any card (their own or another player's) that matches the rank of the top discard, at any time, as often as they like.
  - A wrong stick: the card goes back where it was and the sticker takes a penalty card.
  - Sticking another player's card: the sticker then gives that player one of their own cards. *(guess)*
  - The whole table pauses until that card is given (a random card is given after 20 seconds).
  - To stick: select a card, then press Stick in the action panel.
- Turn timer: the host can set one (off, 10, 15, 20, 30 or 60 seconds). Quick play always uses 30 seconds. The timer restarts after every action you take on your turn (drawing, discarding, looking).
- Extra help (private rooms only, each one on or off; quick play has none):
  - Photographic memory: once you have seen a card, it stays face up for you wherever it moves.
  - Card notes: select cards (tap one, or hold and drag across several), press Note, pick the ranks it is or isn't and who knows it, then Apply. With one card you edit that card's note. Only you see your notes, and they follow the card.
  - Card counter: a Cards left button under the log shows how many of each card have not been discarded yet.
- After the final turn, the sticking window lasts as long as the turn timer. With no timer, the cards are revealed once everyone presses "No more sticks".
- The Cambrio caller wins ties. Any other tie goes to the player with the lowest single card (a player with no cards left counts as lowest). If that also ties, they share the win.

## Other guesses (easy to change)

1. The host picks 4 or 6 cards each and the max players (2 to 8) in the lobby (6 cards allows up to 6 players). At the start you see your bottom row (2 cards, or 3 with 6 cards) until you press "I've got them" or 10 seconds pass (in quick play, the 10 seconds start once everyone has arrived).
2. Calling Cambrio uses your turn and everyone else gets one more turn. The caller's cards are not locked: powers and sticks still work on them.
3. When the turn timer runs out, the turn is skipped (a drawn card is discarded without using its power). Timers freeze while the table waits for a card to be given. With no timer, a player who is away on their turn is skipped after 45 seconds.
5. Quick play starts a game of 4 right away, or of 2 or 3 once nobody new has joined for 10 seconds.
4. 2 to 8 players. The first player rotates each round, and the lobby keeps running totals.

## Hosting (free)

Recommended: **Render** free web service.

1. Push this folder to a GitHub repository.
2. On render.com: New → Web Service → pick the repo. Render reads `render.yaml` (build `npm install`, start `npm start`).
3. The site is live at `https://<name>.onrender.com`.

Free services sleep after about 15 minutes with nobody connected and take about a minute to wake up on the next visit. Open rooms are lost when it sleeps.

## Custom domain

Once the site is on Render: Settings → Custom Domains → add `playcambrio.com` and `www.playcambrio.com`. Render shows the exact DNS records. Usually:

- `www` → **CNAME** to `<name>.onrender.com`
- root `@` → **A** record to the IP Render shows (or ALIAS/ANAME to `<name>.onrender.com` if your registrar supports it)

HTTPS certificates are issued automatically.
