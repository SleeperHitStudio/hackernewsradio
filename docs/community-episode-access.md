# Community episode access

## Decision

HNR asks a listener to follow the show on Spotify, then trusts the listener's
“I followed” confirmation. A confirmed browser may request one new episode.

This is intentionally an honor system. Spotify does not expose a public list of
podcast followers or send HNR a follow webhook. Its Web API can check the
current user's saved library only after OAuth, and a Spotify app in Development
Mode is limited to five manually allowlisted users. That makes OAuth unsuitable
as the public gate.

The Spotify OAuth implementation remains in place for development and testing:

- `GET /api/auth/spotify/start`
- `GET /api/auth/spotify/callback`
- `GET /api/auth/spotify/status`
- `spotify_oauth_states`, `spotify_users`, and `spotify_sessions` in D1

It must not be presented as the public unlock unless the Spotify app eventually
receives Extended Quota Mode.

## Public flow

1. A listener submits a Hacker News thread.
2. Existing queued, running, or completed episodes are returned immediately and
   never consume an unlock.
3. For a new thread, HNR presents the Spotify show badge.
4. The listener follows the show and clicks “I followed — unlock my episode.”
5. If a complete key pair is configured, HNR shows an explicit, always-visible
   Cloudflare Turnstile widget and requires it to succeed. Loader failures show
   a retry control instead of leaving an impossible confirmation button.
6. HNR creates an opaque, random browser token, stores only its SHA-256 hash in
   D1, and sends the raw token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie.
7. The token receives one atomic generation claim. Parallel requests cannot
   spend it twice.
8. If HNR cannot create the episode workflow, the claim is released so a
   transient failure does not consume the listener's request.

The relevant public endpoints are:

- `GET /api/community/config`
- `GET /api/community/status`
- `POST /api/community/confirm-follow`
- `POST /api/generate`

The D1 table is `community_browser_entitlements`.

## What “one user” means

HNR can reliably enforce one request per browser cookie, not one request per
human. Clearing cookies, using private browsing, changing browsers, or changing
devices creates another identity. The UI says “one episode in this browser” so
the product does not imply stronger enforcement than the system provides.

Do not use IP addresses as durable user identities. Shared networks would
penalize unrelated listeners, while changing networks would bypass the limit.

If abuse becomes materially expensive, the next enforcement step should be a
verified email magic link or passkey, with one generation recorded against that
server-side identity. Keep the Spotify follow request as the social exchange;
do not claim that HNR verified the follow.

## Turnstile configuration

Turnstile is optional at runtime but recommended in production. Configure both
values or neither:

- `TURNSTILE_SITE_KEY`: public Worker variable returned to the browser.
- `TURNSTILE_SECRET_KEY`: encrypted Worker secret used only for Siteverify.

Older HNR setups used `TURNSTILE_CLIENT_ID` and
`TURNSTILE_CLIENT_SECRET`. Those aliases remain supported, but new deployments
should use the canonical names above.

Create a managed widget restricted to `hnradio.net` and `www.hnradio.net`. Add
the site key to `wrangler.jsonc` under `vars`, then upload the secret without
committing it:

```sh
printf '%s' "$TURNSTILE_SECRET_KEY" | npx wrangler secret put TURNSTILE_SECRET_KEY
```

When neither value is configured, the honor/cookie gate remains functional but
does not perform a bot challenge. A partial key rollout also temporarily
disables the challenge: the public config exposes no site key and the server
does not demand a token. This intentionally fails open for the optional bot
layer so a secret-only or site-key-only deployment cannot strand humans behind
an invisible challenge. Once both values are present, the browser always
renders the widget before enabling confirmation and the server verifies the
token.

## Privacy and retention

The public gate stores a random token hash, confirmation time, generation time,
and generated HN item ID. It does not require a name, email address, Spotify
profile, or IP address. The browser cookie lasts one year. OAuth test data is
separate and should be deleted if the development integration is retired.

## Spotify production access

Development Mode supports at most five allowlisted users. A public OAuth gate
would require Spotify Extended Quota Mode. Until that access is granted, the
honor-based public flow is the supported production behavior.

Official references:

- <https://developer.spotify.com/documentation/web-api/concepts/quota-modes>
- <https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide>
