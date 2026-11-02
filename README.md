# FairShift

Fair sports sub-rotation and game stats. Free and open source, runs entirely in your browser - no server, no accounts, no network. All data lives in the browser's localStorage on your device.

Built for the sideline problem every coach knows: give every kid roughly equal court time, rotate positions fairly, and keep a simple record of goals.

## Quick start

```sh
npm install
npm run dev        # local dev server with hot reload
npm run build      # bundle to a single self-contained dist/index.html
npm test           # run the unit suite
npm run coverage   # unit suite + coverage report
```

`npm run build` inlines the app into one `dist/index.html` you can open directly (great on a phone) or drop on any static host. Alongside it the build emits the PWA files (`sw.js`, `manifest.webmanifest`, icons).

**Offline install:** serve `dist/` over http(s) (any static host, e.g. GitHub Pages), open it, and add it to your home screen. The service worker then caches everything, so it launches and runs with no network. Opening `index.html` straight off disk (`file://`) still works too - you just don't get the offline service worker there (browsers only allow service workers over http/https).

## What it does

- **Teams and squad** - save multiple teams and their rosters; mark who is present today.
- **Dynamic positions** - define any named on-court roles per team (GK, Defender, whatever). Each position has a rotation cadence and per-player eligibility. Leave positions empty for plain subs. A position pins its holder on court for its cadence:
  - **Per shift** - a new eligible holder every sub (how a rotating keeper works).
  - **Per half** - one holder stays in the role for a whole half, then it rotates.
  - **Whole game** - one holder keeps the role all game.

  Mark one position as the **Goalie** to attribute goals conceded to whoever is in goal.
- **Fair rotation** - set court size, halves, half length and sub interval, and it builds a shift-by-shift plan that splits court time as evenly as mathematically possible while rotating each position fairly among its eligible players. "Reshuffle" varies who gets the unavoidable extra stint.
- **Exact shift times** - sub length is used exactly as set (type `m:ss` or decimal minutes into the half-length and sub-every boxes). Nothing is stretched to fit the half: if a shift would run past half time it is cut there and **resumes with the same players at the start of the next half**, and the last shift of the game is simply the shorter remainder. Fairness is balanced on the real seconds each player gets.
- **Timer per player** - an option in setup that drops the shared shift clock. Each player on court gets their own stint timer (staggered at kick-off so subs come one at a time; set "First sub no sooner than" to choose how long the first player stays on, otherwise it is a 1/n share of the stint); when one runs out the bench player with the least court time is suggested to take over, and you tap the row once the sub is made (or tap a player to pick someone else, or tap a bench player to put them on now). A keeper or other position passes to the incoming player if they are eligible, otherwise you choose who takes it. Half and whole-game roles are held for their tenure. The same players carry on after half time.
- **Rolling subs** - a "Subs at once" setting caps how many players change at each shift change (0 = auto, change whoever fairness dictates; 1 or 2 = roll players on and off a couple at a time for continuity, common with younger teams). Positioned players (e.g. the keeper) are the last to be rotated off, so the outfield cycles around them. The fair-share table shows the resulting spread so you can balance continuity against even time.
- **Installable and fully offline** - built as a PWA: add it to your home screen and it runs with no network at all, its data living on the device. When a new version is deployed, a small "New version available - Reload" bar appears; everything else keeps working until you choose to reload.
- **Suggest fairest sub timer** - one tap picks the sub interval (in 10-second steps) that makes court time as even as possible for the number of players present, the court size, and the total play time. It tells you the result up front, e.g. "Every 3:20 - 3 shifts/half - all play 13.3 min (perfectly equal).".
- **Live game mode** - a big **next-sub countdown** with a progress bar leads the screen, above explicit **"off → on" pairing rows** so it is unambiguous who replaces whom (the keeper handover is called out with a "GK" tag). A buzzer/vibration fires at each shift change, players about to come off are flagged on the court, and the countdown turns amber in the final seconds. **Subs wait for you**: when the timer runs out the line-up stays exactly as it is and the clock counts up how overdue the sub is. **Tap each sub row once it has actually been made** (or "Sub all now"); once the last one is in, the rest of the half is re-timed and every later shift is rebuilt from the court time each player has really had, so the game still ends as even as possible. "Undo sub" takes back a mis-tap. **Tap any on-court player to drop them straight into a position** (e.g. put the player coming on into goal) - the override sticks for the shift and flows through to goals-conceded stats. Survives a page refresh - an in-progress game is saved continuously.
- **Goals** - one tap per team; pick the scorer for your goals. Goals against are tagged with the keeper on court at the time.
- **History and stats** - every finished game is stored forever, with per-player minutes, goals, keeper minutes and goals-conceded-as-keeper aggregated across all games.
- **Share a team** - "Share team" shows a QR code and a link holding the team name, positions and players (not game history). Opening the link on another device offers to add it as a new team. The data lives in the URL fragment, so it never goes to a server.
- **Export / import** - back up or move data as JSON, or export goals as CSV for a spreadsheet.

## First use case: kids floorball

4 on court (1 a keeper) plus subs, two 10-minute halves. A new team already has a per-shift **GK** position, so just: add players, mark the keeper-eligible kids' **GK** chip, set On court = 4, Halves = 2, Half length = 10, Sub every = 2.5, then **Build fair rotation**.

## Project layout

Standard native Web Components (custom elements) in TypeScript, built with Vite. The logic is separated from the view so it is unit-tested to 100% coverage.

```
src/
  types.ts        domain types
  format.ts       small pure helpers (clock/minute formatting, escaping)
  rotation.ts     the fair-rotation engine (pure)
  suggest.ts      fairest sub-interval suggester (pure)
  game.ts         live-clock, sub confirmation and re-balancing (pure)
  stats.ts        aggregation + CSV export (pure)
  share.ts        team share links: encode/decode/validate + QR (pure)
  store.ts        state + localStorage persistence + all domain actions
  pwa.ts          service-worker registration + update-prompt bar
  components/      custom elements (app shell + setup/schedule/live/history views)
  styles/app.css   global stylesheet
pwa/service-worker.js   cache-first offline worker (versioned at build time)
public/          manifest + icons, copied verbatim into the build
```

## Data and privacy

Everything stays in the browser on your device; nothing is sent anywhere. Clearing browser storage (or "Erase everything") deletes it, so export a JSON backup now and then.

## License

Apache License 2.0 - see [LICENSE](LICENSE).
