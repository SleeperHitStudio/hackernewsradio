export const TURNSTILE_RETRY_MESSAGE = 'The anti-bot check was rejected. Please retry it.'

export function acceptTurnstileToken(token, {
  setToken,
  setWidgetError,
  setWidgetLoaded,
  setPageError,
}) {
  setToken(token)
  setWidgetError(null)
  setWidgetLoaded(true)
  setPageError(null)
}

export function resetRejectedTurnstile({
  turnstile,
  widgetId,
  setToken,
  setWidgetError,
  setWidgetLoaded,
  remount,
}) {
  setToken('')
  setWidgetLoaded(false)
  setWidgetError(TURNSTILE_RETRY_MESSAGE)

  if (turnstile && widgetId != null && typeof turnstile.reset === 'function') {
    try {
      turnstile.reset(widgetId)
      return 'reset'
    } catch {
      // A stale widget id can survive a navigation or extension reload. In
      // that case, let React tear down the old widget and mount a fresh one.
    }
  }

  remount()
  return 'remount'
}
