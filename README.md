# 📻 Hacker News Radio

Turn any Hacker News comment thread into an episode of a **profane, ridiculous,
off-center panel podcast** — a fixed recurring cast reads and argues the actual
thread, swearing constantly, derailing into absurd tangents, and playing it all
completely straight. Sparse music, grounded SFX. One URL in, a durable MP3 out.

The hosts are pinned, every episode — a satire of Silicon Valley archetypes.
Their full canon (bios, wants, wounds, relationships, world rules) lives in the
HNRadio project's **Series Bible** on the Sleeper Hit side, which the planner
auto-loads for every episode:

- **Gary** — the Failed Founder; burned a $38M Series B on Bauxlite, his
  vertically-integrated aluminum supply-chain startup ("we were disrupting a
  4,000-year-old metal"). Deadpan, haunted, opens every show.
- **Maeve** — the VC; general partner at a $2B fund; turns every disaster into
  "an interesting thesis"; passed on Gary's Series C and mentions it.
- **Obi** — the Infra Lifer; Bangalore-born staff SRE ("Obi" is the pager
  handle that stuck); Indian-accented voice; despises hype, founders, and
  especially Gary — profanely.
- **Gruner** — an alien field researcher whose implanted voicebox converter was
  **trained on tech podcasts**: German-accented English made of Valley lingo
  used slightly wrong ("zis take has no priors, ja"), **autotuned** — the
  converter's signature sound.

Every episode opens and closes with the show's **jazz theme** — sleazy
late-night jazz (upright bass, brushed drums, smoky sax), the same identity
every episode.

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

Set `SLEEPERHIT_API_KEY` for generation. Public listener requests use the
honor-based Spotify follow confirmation and a server-issued browser cookie;
they do **not** use Spotify OAuth. The existing OAuth endpoints are retained
only for development/testing with Spotify's allowlisted development users. If
you exercise that test path, set `SPOTIFY_CLIENT_ID` and
`SPOTIFY_CLIENT_SECRET`, and register
`https://hnradio.net/api/auth/spotify/callback` as the redirect URI. Everything
else has a default (see `.env.example`). `SLEEPERHIT_API_BASE` defaults to
production.

The Worker recovery endpoints, `POST /api/dramas/:id/resume` and
`POST /api/dramas/:id/repair`, are disabled unless `HNR_OPERATOR_TOKEN` is set
and require `Authorization: Bearer <token>`. Configure production with
`npx wrangler secret put HNR_OPERATOR_TOKEN`; do secret/config updates outside
the nightly run window because they can restart live Worker/Workflow state.

Nightly generation uses one persisted, cross-date circuit for provider-policy,
quota, and deterministic contract failures. The first systemic failure stops
new generation immediately. While the circuit is open, the hourly reconciler
permits at most one probe globally and resumes the existing Sleeper Hit plan or
job under the same HNR episode id. Producing an artifact closes the circuit;
the following tick restores normal batch filling. Post-production recovery for
an already-created artifact remains independent from this generation circuit.

See [Community episode access](docs/community-episode-access.md) for the public
gate's limitation, abuse controls, Turnstile behavior, and optional Spotify
OAuth test path.


## Deploy

It's a plain Node + Vite app, deployable anywhere:

```bash
npm run build       # builds web/dist
npm start           # serves the API + built frontend on $PORT
```
