/**
 * Operator email (Resend), shared by the nightly reconciler and the pipeline.
 *
 * `alertOnce` latches on a D1 setting so a condition that persists across
 * hourly ticks — a blocked feed, a project that is not ready — emails the
 * operator ONCE, not every hour. Whoever clears the condition clears the latch
 * (`clearAlertLatch`), so the next outage alerts again.
 */

export const ALERT_FROM = 'HN Radio <noreply@updates.sleeperhit.studio>'

/** Latch for "episodes are finished but the feed will not take them". */
export const PUBLISH_BLOCKED_ALERT_KEY = 'alertLatch:publish-blocked'

export function alertsConfigured(env) {
  return Boolean(env?.RESEND_API_KEY && env?.ALERT_EMAIL)
}

/** Send one operator email. Resolves true only when Resend accepted it. */
export async function sendOperatorAlert(env, { subject, lines }) {
  if (!alertsConfigured(env)) return false
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: ALERT_FROM,
        to: [env.ALERT_EMAIL],
        subject,
        text: (Array.isArray(lines) ? lines : [String(lines ?? '')]).join('\n'),
      }),
    })
    return Boolean(res?.ok)
  } catch {
    return false
  }
}

/**
 * Email once per latch. The latch is CLAIMED atomically before the send (two
 * concurrent publish runs cannot both win it), and released again when Resend
 * does not accept the message, so a failed send is retried on the next
 * observation.
 */
export async function alertOnce(env, key, { subject, lines }, { claimSetting, setSetting, now = () => new Date() }) {
  if (!alertsConfigured(env)) return false
  const claimed = await claimSetting(env.DB, key, { claimedAt: now().toISOString(), subject })
  if (!claimed) return false
  const sent = await sendOperatorAlert(env, { subject, lines })
  if (!sent) {
    await setSetting(env.DB, key, null)
    return false
  }
  await setSetting(env.DB, key, { sentAt: now().toISOString(), subject })
  return true
}

export async function clearAlertLatch(env, key, { getSetting, setSetting }) {
  if (await getSetting(env.DB, key)) await setSetting(env.DB, key, null)
}
