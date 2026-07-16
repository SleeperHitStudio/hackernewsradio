const encoder = new TextEncoder()

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))))
}

/** Compare fixed-length digests so the token itself is never compared with an
 * early-return string equality check. */
export async function constantTimeTokenEqual(left, right) {
  const [leftDigest, rightDigest] = await Promise.all([sha256(left), sha256(right)])
  let difference = 0
  for (let index = 0; index < leftDigest.length; index++) {
    difference |= leftDigest[index] ^ rightDigest[index]
  }
  return difference === 0
}

/**
 * The recovery endpoints are deliberately absent until an operator opts in by
 * configuring HNR_OPERATOR_TOKEN. Once enabled they require the exact Bearer
 * credential; callers cannot trigger paid repair work anonymously.
 */
export async function operatorAuthorization(request, configuredToken) {
  if (!configuredToken) return 'disabled'
  const authorization = request.headers.get('Authorization') || ''
  const authorized = await constantTimeTokenEqual(authorization, `Bearer ${configuredToken}`)
  return authorized ? 'authorized' : 'denied'
}
