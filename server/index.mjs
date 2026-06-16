import './env.mjs' // must be first — populates process.env before config reads it
import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { config } from './config.mjs'
import { listDramas, getDrama } from './store.mjs'
import { startGeneration } from './generate.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '256kb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, apiBase: config.apiBase, hasKey: Boolean(config.apiKey) })
})

app.get('/api/dramas', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const includeFailed = req.query.includeFailed === 'true'
  res.json({ dramas: await listDramas({ q, includeFailed }) })
})

app.get('/api/dramas/:id', async (req, res) => {
  const drama = await getDrama(req.params.id)
  if (!drama) return res.status(404).json({ error: 'Not found' })
  res.json({ drama })
})

app.post('/api/generate', async (req, res) => {
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
})

// In production, serve the built frontend. In dev, Vite serves it and proxies
// /api here, so this static block is simply inert.
const dist = join(__dirname, '..', 'web', 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')))
}

app.listen(config.port, () => {
  console.log(`hackernewsradio server on http://localhost:${config.port}`)
  console.log(`  Story API: ${config.apiBase}  (key ${config.apiKey ? 'loaded' : 'MISSING'})`)
})
