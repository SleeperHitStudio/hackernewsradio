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
HN URL → verify official HN comment count against cursor-paged Algolia search
         merged with Algolia's recursive reply tree (including >1,000 comments)
       → fetch + reader-extract the complete linked article
       → upload one integrity-declared full source pack → Story API:
         source → plan → approve → job → pin voices → autotune Gruner
                → shape music to bookends → finalize(audio) → MP3
```

**Source completeness is fail-closed.** An episode starts only when HNR has an
exact count-matched comment snapshot and, when present, a complete unclipped
linked-article extraction and complete self-post. Unsupported media, unreadable/paywalled article
previews, partial HTTP bodies, count disagreement, and sources above the
downstream no-clipping limit are rejected instead of producing a shallow
episode. HNR marks the upload `sourceContextMode: full`; Sleeper Hit verifies
the retained-text hash and HNR's article/self-post/comment/size declaration before
passing the exact source to both planning and final script writing.

**One source per thread.** Each upload carries the thread's identity as
top-level `producer: "hackernewsradio"` + `externalId: "<HN item id>"`. A retry
of the same thread gets the source its first attempt captured back
(`deduplicated: true`) instead of uploading — and paying to digest — it again.
Only an attempt that failed *before any plan existed*, on a thread that has
since grown materially (10+ comments and 20%+), retires the old capture
(`DELETE`) and takes a fresh one.

**Voice pinning:** the first episode *adopts* whatever voices the planner cast
for the four hosts (saved in the `settings` table under `pinnedVoices`), and
every later episode recasts its hosts back to that set — the show sounds the
same forever. Each episode also writes the hosts' portraits **and pinned
voices** into the project **cast canon** (`PATCH …/cast-canon`, characters
only: `name`, `avatarUrl`, `voiceId`, `voiceProvider`), which is where Sleeper
Hit looks for a voice before it lets a table read start. A canon refusal fails
the episode; it is never swallowed. To re-roll the cast, delete that row and
the next episode adopts fresh voices.

**HNR never writes the Series Bible.** The show's memory lives on its releases
and in the `showMemory` setting (read from the finished script, in pages of
500 entries — the platform's cap).

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

**Readiness first.** Before a tick fetches, uploads, plans, or buys anything,
it reads `GET /story-projects/{id}` (`workspaceGate`, and `tableReadReadiness`
once the platform reports it) and `GET /credits` (an episode needs 26). A
project that has not finished its development stage (`project_not_ready`), a
cast the platform cannot voice (`cast_not_ready`), or a balance below one
episode (`quota`) opens the generation circuit with that class and emails the
operator once. For these classes the hourly probe is this same free read,
never another paid episode; when it passes, the circuit closes and the episode
the outage stopped resumes. A job refused with `402` is re-sent later under
the **same** Idempotency-Key and body, so the platform resumes or creates that
one job — never a second. A typed `409` (`project_precondition_failed`,
`cast_precondition_failed`) is state, not a fault: it stops the run and is
never retried. Only `409 idempotency_conflict` ("already processing") is
transient.

**Publishing is unattended, so it runs under the series' standing approval.**
HNR never claims `userConfirmed` on a publish. It publishes only when
`GET /publishing-series/{id}` reports a standing approval bound to HNR's key
(set `SLEEPERHIT_API_KEY_ID` to have HNR check the binding itself); under that
grant it also approves plans without a confirmation claim. Without the grant —
or when the feed refuses — no release is created, the episode stays `ready`
and playable on hnradio.net with `publishState: "blocked"` and the refusal's
code, and the operator is emailed once per outage. The nightly retries **only
the publish step** for a finished MP3 (no post-production, no re-finalize),
backing off from one hour to a day, and a held episode keeps its batch slot.

Nightly generation uses one persisted, cross-date circuit for provider-policy,
project/cast readiness, quota, and deterministic contract failures. The first
systemic failure stops new generation immediately. While the circuit is open, the hourly reconciler
permits at most one probe globally and resumes the existing Sleeper Hit plan or
job under the same HNR episode id. Producing an artifact closes the circuit;
the following tick may start the next episode. Even with the circuit closed,
each reconciliation starts or resumes at most one pre-artifact generation
globally, and only the newest pending nightly batch may own that work. Older
batches drain already-active work and artifact publishing without minting
duplicates. Post-production recovery for an already-created artifact remains
independent from this generation circuit.

See [Community episode access](docs/community-episode-access.md) for the public
gate's limitation, abuse controls, Turnstile behavior, and optional Spotify
OAuth test path.


## Deploy

It's a plain Node + Vite app, deployable anywhere:

```bash
npm run build       # builds web/dist
npm start           # serves the API + built frontend on $PORT
```
