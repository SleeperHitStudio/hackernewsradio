const COOKIE = 'hnr_spotify_session'
const SHOW_ID = '033Q5rX4lklQvrQlxikj7Q'
export const SPOTIFY_SHOW_URL = `https://open.spotify.com/show/${SHOW_ID}`

const isoAfter = (seconds) => new Date(Date.now() + seconds * 1000).toISOString()
const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const sha256 = async (value) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const cookieToken = (request) => {
  const raw = request.headers.get('Cookie') || ''
  for (const part of raw.split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === COOKIE) return decodeURIComponent(value.join('='))
  }
  return null
}
const safeReturnTo = (value) => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/'

async function spotifyToken(env, code) {
  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://hnradio.net/api/auth/spotify/callback',
  })
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`Spotify token exchange failed (${res.status})`)
  return res.json()
}

async function spotifyJson(path, accessToken) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Spotify API request failed (${res.status})`)
  return res.json()
}

export async function spotifyStart(request, env, url) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return new Response('Spotify login is not configured.', { status: 503 })
  const state = randomToken()
  const returnTo = safeReturnTo(url.searchParams.get('returnTo'))
  await env.DB.prepare('INSERT INTO spotify_oauth_states (state, return_to, expires_at) VALUES (?1, ?2, ?3)')
    .bind(state, returnTo, isoAfter(10 * 60)).run()
  const authorize = new URL('https://accounts.spotify.com/authorize')
  authorize.searchParams.set('client_id', env.SPOTIFY_CLIENT_ID)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('redirect_uri', 'https://hnradio.net/api/auth/spotify/callback')
  authorize.searchParams.set('scope', 'user-library-read')
  authorize.searchParams.set('state', state)
  return Response.redirect(authorize.toString(), 302)
}

export async function spotifyCallback(request, env, url) {
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  if (!state || !code || url.searchParams.get('error')) return Response.redirect('https://hnradio.net/?spotify=denied', 302)
  const row = await env.DB.prepare('SELECT return_to, expires_at FROM spotify_oauth_states WHERE state = ?1').bind(state).first()
  await env.DB.prepare('DELETE FROM spotify_oauth_states WHERE state = ?1').bind(state).run()
  if (!row || row.expires_at <= new Date().toISOString()) return Response.redirect('https://hnradio.net/?spotify=expired', 302)

  const token = await spotifyToken(env, code)
  const [profile, contains] = await Promise.all([
    spotifyJson('/me', token.access_token),
    spotifyJson(`/me/library/contains?uris=${encodeURIComponent(`spotify:show:${SHOW_ID}`)}`, token.access_token),
  ])
  const follows = Array.isArray(contains) && contains[0] === true
  await env.DB.prepare(`INSERT INTO spotify_users (spotify_user_id, display_name, follows_show, verified_at)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(spotify_user_id) DO UPDATE SET display_name=excluded.display_name, follows_show=excluded.follows_show, verified_at=excluded.verified_at`)
    .bind(profile.id, profile.display_name || null, follows ? 1 : 0, new Date().toISOString()).run()

  const session = randomToken()
  await env.DB.prepare('INSERT INTO spotify_sessions (token_hash, spotify_user_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await sha256(session), profile.id, isoAfter(30 * 24 * 60 * 60)).run()
  const destination = new URL(safeReturnTo(row.return_to), 'https://hnradio.net')
  destination.searchParams.set('spotify', follows ? 'verified' : 'not_following')
  const headers = new Headers({ Location: destination.toString() })
  headers.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(session)}; Path=/; Max-Age=${30 * 24 * 60 * 60}; HttpOnly; Secure; SameSite=Lax`)
  return new Response(null, { status: 302, headers })
}

export async function spotifyUser(request, env) {
  const token = cookieToken(request)
  if (!token) return null
  return env.DB.prepare(`SELECT u.spotify_user_id, u.display_name, u.follows_show, u.verified_at,
      u.generation_used_at, u.generated_hn_id
    FROM spotify_sessions s JOIN spotify_users u ON u.spotify_user_id = s.spotify_user_id
    WHERE s.token_hash = ?1 AND s.expires_at > ?2`)
    .bind(await sha256(token), new Date().toISOString()).first()
}

export async function spotifyStatus(request, env) {
  const user = await spotifyUser(request, env)
  return user ? {
    authenticated: true,
    follows: user.follows_show === 1,
    used: Boolean(user.generation_used_at),
    generatedHnId: user.generated_hn_id || null,
  } : { authenticated: false, follows: false, used: false, generatedHnId: null }
}

export async function claimSpotifyGeneration(request, env, hnId) {
  const user = await spotifyUser(request, env)
  if (!user) return { ok: false, code: 'spotify_login_required' }
  if (user.follows_show !== 1) return { ok: false, code: 'spotify_follow_required' }
  const result = await env.DB.prepare(`UPDATE spotify_users SET generation_used_at = ?1, generated_hn_id = ?2
    WHERE spotify_user_id = ?3 AND follows_show = 1 AND generation_used_at IS NULL`)
    .bind(new Date().toISOString(), String(hnId), user.spotify_user_id).run()
  return result.meta?.changes === 1
    ? { ok: true }
    : { ok: false, code: 'spotify_generation_used', generatedHnId: user.generated_hn_id || null }
}

export async function releaseSpotifyGeneration(request, env, hnId) {
  const user = await spotifyUser(request, env)
  if (!user) return
  await env.DB.prepare(`UPDATE spotify_users SET generation_used_at = NULL, generated_hn_id = NULL
    WHERE spotify_user_id = ?1 AND generated_hn_id = ?2`)
    .bind(user.spotify_user_id, String(hnId)).run()
}
