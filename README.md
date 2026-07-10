# 📻 Hacker News Radio

Turn any Hacker News comment thread into an episode of a **profane, ridiculous,
off-center panel podcast** — a fixed recurring cast reads and argues the actual
thread, swearing constantly, derailing into absurd tangents, and playing it all
completely straight. Sparse music, grounded SFX. One URL in, a durable MP3 out.

The hosts are pinned, every episode:

- **Gary** — human man, 40s; ex-founder still quietly processing the pen-plotter
  startup that ruined him; opens every show.
- **Maeve** — human woman; ex-security-researcher energy; surgically precise,
  unsettlingly calm, politely devastating.
- **Obi** — Lagos-born infrastructure engineer; grounded, allergic to hype —
  and openly, relentlessly mean to Gary (dry contempt, never shouty).
- **Gruner** — an alien field researcher whose implanted voicebox converter
  mapped his native tongue closest to German: he speaks heavily German-accented
  English, and his lines are **autotuned** (the Story API's voice-modification
  effect) — the converter's signature sound.

It's a thin conductor over the [Sleeper Hit Studio](https://sleeperhit.studio)
**table-read pipeline** (the same Story API the Sleeper Hit web app, CLI, and MCP
server use). We fetch the thread, hand it to Sleeper Hit's craft engine with a
tight creative brief — *the four hosts above, real quotes, sparse bookend music,
grounded SFX* — and let it write, cast, score, and mix the final audio.

## How it works

```
HN URL → fetch thread (Algolia) → Story API:
  project → source → plan → approve → job → pin voices → autotune Gruner
          → shape music to bookends → finalize(audio) → MP3
```

**Voice pinning:** the Story API can't pin voices at plan time, so the first
episode *adopts* whatever voices the planner cast for the four hosts (saved in
the `settings` table under `pinnedVoices`), and every later episode recasts its
hosts back to that set — the show sounds the same forever. To re-roll the cast,
delete that row and the next episode adopts fresh voices.

Length scales with the size of the debate.

## Run it locally

```bash
npm install
cp .env.example .env        # then paste your Sleeper Hit API key
npm run dev
```

- Frontend: http://localhost:5781
- Backend API: http://localhost:5780

Paste a thread URL, or deep-link a generation:

```
http://localhost:5781/?url=https://news.ycombinator.com/item?id=12345678
```

Already-generated dramas are surfaced on the home page and survive restarts
(stored in `data/dramas.json`); re-requesting the same thread returns the
existing MP3 instead of spending credits again.

## Config

The only thing to set is `SLEEPERHIT_API_KEY`. Everything else has a default
(see `.env.example`). `SLEEPERHIT_API_BASE` defaults to production.

## Deploy

It's a plain Node + Vite app, deployable anywhere:

```bash
npm run build       # builds web/dist
npm start           # serves the API + built frontend on $PORT
```
