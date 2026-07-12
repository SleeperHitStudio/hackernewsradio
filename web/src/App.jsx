import React, { useCallback, useEffect, useRef, useState } from 'react'

const TERMINAL = new Set(['ready', 'failed'])

function timeAgo(iso) {
  if (!iso) return ''
  const d = (Date.now() - new Date(iso).getTime()) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return `${Math.floor(d / 86400)}d ago`
}

function StatusPill({ status }) {
  const label = { queued: 'Queued', running: 'On air', ready: 'Ready' }[status] || status
  return <span className={`pill pill--${status}`}>{label}</span>
}

function ShareRow({ drama }) {
  const [copied, setCopied] = useState(false)
  const link = `${location.origin}/e/${drama.id}`
  const text = `HNR — ${drama.title}`
  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* clipboard unavailable */ }
  }
  async function nativeShare() {
    try { await navigator.share({ title: text, url: link }) } catch { /* dismissed */ }
  }
  const enc = encodeURIComponent
  return (
    <div className="share">
      <button type="button" className="share__btn" onClick={copy}>{copied ? 'Copied ✓' : 'Copy link'}</button>
      <a className="share__btn" href={`https://x.com/intent/post?text=${enc(text)}&url=${enc(link)}`} target="_blank" rel="noreferrer">Post on X</a>
      <a className="share__btn" href={`https://www.linkedin.com/sharing/share-offsite/?url=${enc(link)}`} target="_blank" rel="noreferrer">LinkedIn</a>
      {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
        <button type="button" className="share__btn" onClick={nativeShare}>Share…</button>
      )}
    </div>
  )
}

function EpisodeCard({ drama, highlighted }) {
  const log = drama.progress?.slice(-4) ?? []
  const ref = useRef(null)
  useEffect(() => {
    if (highlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [highlighted])
  return (
    <article className={`card${highlighted ? ' card--highlight' : ''}`} id={`e-${drama.id}`} ref={ref}>
      <header className="card__head">
        <h3 className="card__title">
          <a className="card__permalink" href={`/e/${drama.id}`}>{drama.title}</a>
        </h3>
        <StatusPill status={drama.status} />
      </header>
      <div className="card__meta">
        <a href={drama.url} target="_blank" rel="noreferrer">thread ↗</a>
        <span>·</span>
        <span>{drama.commentCount} comments</span>
        <span>·</span>
        <span>{timeAgo(drama.createdAt)}</span>
      </div>

      {drama.status === 'ready' && drama.audioUrl && (
        <audio className="player" controls preload="none" src={drama.audioUrl} />
      )}

      {drama.status === 'ready' && <ShareRow drama={drama} />}

      {!TERMINAL.has(drama.status) && (
        <ul className="progress">
          {log.map((p, i) => (
            <li key={i}>
              <span className="progress__dot" />
              {p.message}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

export default function App() {
  const [dramas, setDramas] = useState([])
  const [url, setUrl] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const autoFired = useRef(false)
  // Deep link: /e/<episode id> highlights + scrolls to that episode.
  const deepLinkId = (location.pathname.match(/^\/e\/([0-9a-f-]{36})$/) || [])[1] || null

  const refresh = useCallback(async (q) => {
    try {
      const search = (q ?? '').trim()
      const res = await fetch(`/api/dramas${search ? `?q=${encodeURIComponent(search)}` : ''}`)
      const data = await res.json()
      setDramas(data.dramas ?? [])
    } catch {
      /* transient */
    }
  }, [])

  const generate = useCallback(async (targetUrl) => {
    const clean = (targetUrl ?? '').trim()
    if (!clean) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: clean }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to start generation.')
      await refresh(query)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [query, refresh])

  // Initial load + auto-generate from a deep link (?url=… or ?id=…).
  useEffect(() => {
    refresh()
    const sp = new URLSearchParams(window.location.search)
    let param = sp.get('url')
    const id = sp.get('id')
    if (param && id && /\/item\/?$/.test(param)) param = `${param}?id=${id}`
    else if (!param && id) param = `https://news.ycombinator.com/item?id=${id}`
    if (param && !autoFired.current) {
      autoFired.current = true
      setUrl(param)
      generate(param)
    }
  }, [refresh, generate])

  // Poll while any episode is still in flight.
  useEffect(() => {
    const anyRunning = dramas.some((d) => !TERMINAL.has(d.status))
    if (!anyRunning) return
    const t = setInterval(() => refresh(query), 3000)
    return () => clearInterval(t)
  }, [dramas, query, refresh])

  // Debounced server-side search.
  useEffect(() => {
    const t = setTimeout(() => refresh(query), 250)
    return () => clearTimeout(t)
  }, [query, refresh])

  return (
    <>
      <img
        className="hero"
        src="/hero.webp"
        alt="The HNR hosts — Gary, Maeve, Obi, and Gruner — live on air around the studio table"
        width="1672"
        height="941"
        fetchpriority="high"
      />
      <div className="app">
      <header className="masthead">
        <h1>📻 HNR</h1>
        <p>Gary, Maeve, Obi, and Gruner read the day's Hacker News flame wars so you don't have to.</p>
      </header>

      <form
        className="composer"
        onSubmit={(e) => { e.preventDefault(); generate(url) }}
      >
        <input
          type="text"
          placeholder="https://news.ycombinator.com/item?id=…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Starting…' : 'Make the episode'}
        </button>
      </form>
      {error && <p className="composer__error">{error}</p>}

      <div className="searchbar">
        <input
          type="search"
          placeholder="Search your episodes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <section className="feed">
        {dramas.length === 0 && (
          <p className="empty">{query ? 'No episodes match your search.' : 'No episodes yet. Paste a thread above to make the first one.'}</p>
        )}
        {dramas.map((d) => <EpisodeCard key={d.id} drama={d} highlighted={d.id === deepLinkId} />)}
      </section>

      <footer className="foot">
        Powered by <a href="https://sleeperhit.studio" target="_blank" rel="noopener noreferrer">Sleeper Hit Studio</a>
      </footer>
      </div>
    </>
  )
}
