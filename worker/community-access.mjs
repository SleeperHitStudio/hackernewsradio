const COOKIE = 'hnr_community_access'
const MAX_AGE = 365 * 24 * 60 * 60

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

async function verifyTurnstile(request, env, token) {
  if (!env.TURNSTILE_SITE_KEY && !env.TURNSTILE_SECRET_KEY) return true
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY || !token) return false
  const body = new FormData()
  body.append('secret', env.TURNSTILE_SECRET_KEY)
  body.append('response', token)
  const ip = request.headers.get('CF-Connecting-IP')
  if (ip) body.append('remoteip', ip)
  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })
  const verification = await result.json().catch(() => ({}))
  return verification.success === true
}

async function browserEntitlement(request, env) {
  const token = cookieToken(request)
  if (!token) return null
  return env.DB.prepare(`SELECT token_hash, confirmed_at, generation_used_at, generated_hn_id
    FROM community_browser_entitlements WHERE token_hash = ?1`)
    .bind(await sha256(token)).first()
}

export function communityConfig(env) {
  return { turnstileSiteKey: env.TURNSTILE_SITE_KEY || null }
}

export async function confirmCommunityFollow(request, env) {
  let body
  try { body = await request.json() } catch { body = {} }
  if (!await verifyTurnstile(request, env, body?.turnstileToken)) {
    return { ok: false, code: 'turnstile_failed' }
  }

  const existingToken = cookieToken(request)
  const existing = existingToken ? await browserEntitlement(request, env) : null
  const token = existing ? existingToken : randomToken()
  if (!existing) {
    await env.DB.prepare(`INSERT INTO community_browser_entitlements (token_hash, confirmed_at)
      VALUES (?1, ?2) ON CONFLICT(token_hash) DO NOTHING`)
      .bind(await sha256(token), new Date().toISOString()).run()
  }
  return {
    ok: true,
    used: Boolean(existing?.generation_used_at),
    generatedHnId: existing?.generated_hn_id || null,
    cookie: `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
  }
}

export async function communityStatus(request, env) {
  const entitlement = await browserEntitlement(request, env)
  return entitlement ? {
    confirmed: true,
    used: Boolean(entitlement.generation_used_at),
    generatedHnId: entitlement.generated_hn_id || null,
  } : { confirmed: false, used: false, generatedHnId: null }
}

export async function claimCommunityGeneration(request, env, hnId) {
  const entitlement = await browserEntitlement(request, env)
  if (!entitlement) return { ok: false, code: 'community_confirmation_required' }
  const result = await env.DB.prepare(`UPDATE community_browser_entitlements
    SET generation_used_at = ?1, generated_hn_id = ?2
    WHERE token_hash = ?3 AND generation_used_at IS NULL`)
    .bind(new Date().toISOString(), String(hnId), entitlement.token_hash).run()
  return result.meta?.changes === 1
    ? { ok: true }
    : { ok: false, code: 'community_generation_used', generatedHnId: entitlement.generated_hn_id || null }
}

export async function releaseCommunityGeneration(request, env, hnId) {
  const entitlement = await browserEntitlement(request, env)
  if (!entitlement) return
  await env.DB.prepare(`UPDATE community_browser_entitlements
    SET generation_used_at = NULL, generated_hn_id = NULL
    WHERE token_hash = ?1 AND generated_hn_id = ?2`)
    .bind(entitlement.token_hash, String(hnId)).run()
}

