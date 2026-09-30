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

**Nothing is spent without the standing approval.** HNR is an unattended
producer, so it approves plans and publishes only under the publishing series'
standing approval, bound to HNR's own API key, and never claims
`userConfirmed`. It reads `GET /publishing-series/{id}` and requires
`series.standingApproval.apiKeyId` to equal `SLEEPERHIT_API_KEY_ID` (a required
var: the id of HNR's key, as the Publishing tab shows it) on an active or draft
audio series. A grant that is absent, revoked (`null`), bound to another key or
only to the built-in runner, on a paused series, or unreadable stops
**spending**, not just publishing: the pipeline refuses before any upload,
plan, approval or job, re-checks the grant at the moment it approves a plan
(always with an empty body), and the community `POST /api/generate` path runs
the same preflight before it claims or queues anything.

**Readiness first.** Before a tick fetches, uploads, plans, or buys anything,
it reads `GET /story-projects/{id}` (`workspaceGate`, `tableReadReadiness`),
`GET /credits` (an episode needs 26, or what a refused job's 402 said it needs)
and the series grant. A project that has not finished its development stage
(`project_not_ready`), a cast canon that cannot cover the roster
(`cast_not_ready`), no standing approval (`approval_missing`), too few Studio
Credits (`quota`), or a read the Story API REFUSED — a revoked key, a missing
scope, a deleted project (`access`) — opens a READ-probed generation circuit
and emails the operator once per outage. Its hourly probe is this same free
read, never a paid episode; a passing read closes it. A read that could not be
made (network, 5xx, 429) only skips the tick. Before it judges the cast, the
preflight (tick and `POST /api/generate` alike, never under a locked deploy
gate) pushes HNR's own pinned host voices (`pinnedVoices`) into the cast canon
(a GET, and a free PATCH only when stale) and re-reads the project, so a canon
missing a voice HNR has pinned heals itself. A voice HNR has not pinned is
never invented, and a refused push is a `cast_not_ready` failure naming the
refusal.

A passing read clears an episode's failure only when the read MEASURES that
condition and saw it failing after the episode failed. Otherwise the read
cannot vouch for it: a cast refusal the read does not measure, a provider's
quota/billing/rate cliff (`provider_quota`; the Studio Credit read cannot see
it), or a refusal the gate read did not predict opens an EPISODE-probed circuit
and alerts. A cast refusal the read measured as ready is the plan's own roster:
the item spends its attempt and re-plans. A job refused with `402` is re-sent
later under the **same** Idempotency-Key and body, so the platform resumes or
creates that one job — never a second. A typed 4xx refusal stops the run: no
second plan, no second job (the voiceMap recast is the one exception). Only
`409 idempotency_conflict` ("already processing") is transient.

**Publishing.** Without the grant — or when the feed refuses — no release is
created, the episode stays `ready` and playable on hnradio.net with
`publishState: "blocked"` and the refusal's code, and the operator is emailed
once per outage (the latch is claimed atomically). Publishing keeps ONE release
per artifact: a release already on the feed is recorded, an open one created
after the grant is reused, and one created before it is canceled rather than
left stuck. The nightly retries **only the publish step** for a finished MP3
(no post-production, no re-finalize), backing off from one hour to a day, and a
held episode keeps its batch slot.

Nightly generation uses one persisted, cross-date circuit. The first systemic
failure stops new generation immediately. While an episode-probed circuit is
open, the hourly reconciler permits at most one probe globally and resumes the
existing Sleeper Hit plan or job under the same HNR episode id. Producing an
artifact closes it; the following tick may start the next episode. Even with
the circuit closed, each reconciliation starts or resumes at most one
pre-artifact generation globally, and only the newest pending nightly batch may
own that work. Older batches drain already-active work and artifact publishing
without minting duplicates. Post-production recovery for an already-created
artifact remains independent from this generation circuit.

See [Community episode access](docs/community-episode-access.md) for the public
gate's limitation, abuse controls, Turnstile behavior, and optional Spotify
OAuth test path.


## Deploy

It's a plain Node + Vite app, deployable anywhere:

```bash
npm run build       # builds web/dist
npm start           # serves the API + built frontend on $PORT
```
