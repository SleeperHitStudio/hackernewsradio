# 📻 Hacker News Radio

Turn any Hacker News comment thread into a full **radio drama** — cast, original
score, and sound effects — performed from the actual argument. One URL in, a
durable MP3 out.

It's a thin conductor over the [Sleeper Hit Studio](https://sleeperhit.studio)
**table-read pipeline** (the same Story API the Sleeper Hit web app, CLI, and MCP
server use). We fetch the thread, hand it to Sleeper Hit's craft engine with a
tight creative brief — *≤6 archetype characters, real quotes, genre inferred from
the thread's tone, rich music + SFX* — and let it write, cast, score, and mix the
final audio.

## How it works

```
HN URL → fetch thread (Algolia) → Story API:
  project → source → plan → approve → job → finalize(audio) → MP3
```

The genre isn't configured — it's **inferred**. A flamewar becomes a courtroom
thriller; a Show HN becomes a hopeful comedy; an obituary thread becomes an elegy.
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
