import './env.mjs' // must be first — populates process.env before config reads it
import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { config } from './config.mjs'
import { listDramas, getDrama, findByHnIdAndMode, failStaleRunning } from './store.mjs'
import { startGeneration } from './generate.mjs'
import { startDailySchedule } from './schedule.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '256kb' }))

// Express 4 doesn't catch async-handler rejections — without this, one failed
// DB call inside a route becomes an unhandled rejection and kills the process.
const wrap = (fn) => (req, res) => {
  fn(req, res).catch((err) => {
    console.error(`[api] ${req.method} ${req.path} failed:`, err?.message || err)
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' })
  })
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, apiBase: config.apiBase, hasKey: Boolean(config.apiKey) })
})

app.get('/api/dramas', wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const includeFailed = req.query.includeFailed === 'true'
  res.json({ dramas: await listDramas({ q, includeFailed }) })
}))

app.get('/api/dramas/:id', wrap(async (req, res) => {
  const drama = await getDrama(req.params.id)
  if (!drama) return res.status(404).json({ error: 'Not found' })
  res.json({ drama })
}))

app.post('/api/generate', wrap(async (req, res) => {
  const url = req.body?.url
  if (!url) return res.status(400).json({ error: 'Provide a Hacker News thread "url".' })
  if (!config.apiKey) return res.status(500).json({ error: 'Server is missing SLEEPERHIT_API_KEY.' })
  try {
    const { drama, reused } = await startGeneration(url, {
      force: Boolean(req.body?.force),
    })
    res.json({ drama, reused })
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) })
  }
}))

// In production, serve the built frontend. In dev, Vite serves it and proxies
// /api here, so this static block is simply inert.
const dist = join(__dirname, '..', 'web', 'dist')
if (existsSync(dist)) {
  const { readFileSync } = await import('node:fs')
  const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8')
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // Episode deep links: social crawlers never run the SPA, so /e/:id serves
  // index.html with the title/OG/Twitter tags rewritten for THAT episode. The
  // SPA reads the same path client-side to highlight + scroll to the card.
  app.get('/e/:id', wrap(async (req, res) => {
    const raw = req.params.id
    // Canonical episode ids are the HN item id (stable across regens). Legacy
    // GUID links (shared before the switch) 301 to the canonical URL.
    let drama = null
    if (/^\d+$/.test(raw)) {
      drama = await findByHnIdAndMode(raw, 'podcast')
    } else {
      const byGuid = await getDrama(raw)
      if (byGuid?.hnId) return res.redirect(301, `/e/${byGuid.hnId}`)
    }
    if (!drama) return res.status(404).sendFile(join(dist, 'index.html'))
    const title = `HNR — ${drama.title}`
    const desc = `Gary, Maeve, Obi, and Gruner read the Hacker News thread "${drama.title}" (${drama.commentCount} comments) so you don't have to.`
    const url = `https://hnradio.net/e/${drama.hnId}`
    const html = indexHtml
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
      .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${esc(url)}$2`)
      .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
      .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
      .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
      .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${esc(url)}$2`)
      .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
      .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
      .replace(/(<meta property="og:type" content=")[^"]*(")/, '$1music.song$2')
      .replace('</head>', `<meta property="og:audio" content="${esc(drama.audioUrl || '')}" /><meta property="og:audio:type" content="audio/mpeg" /></head>`)
    res.type('html').send(html)
  }))

  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')))
}

app.listen(config.port, () => {
  console.log(`hackernewsradio server on http://localhost:${config.port}`)
  console.log(`  Story API: ${config.apiBase}  (key ${config.apiKey ? 'loaded' : 'MISSING'})`)
  failStaleRunning().catch((err) => console.error('[store] stale-run cleanup failed:', err?.message || err))
  startDailySchedule()
})
