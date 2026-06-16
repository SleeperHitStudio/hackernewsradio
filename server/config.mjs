/**
 * Config we own. The only thing that ever needs setting is the Sleeper Hit API
 * key; everything else has a sensible default. Reads from the environment (or a
 * local .env, loaded by index.mjs) so the key never lives in source.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const config = {
  // Where the Story API lives. Prod by default — that's where music/SFX/finalize
  // are fully wired. Override with SLEEPERHIT_API_BASE for stage or localhost.
  apiBase: process.env.SLEEPERHIT_API_BASE || 'https://sleeperhit.studio',
  apiKey: process.env.SLEEPERHIT_API_KEY || '',
  port: Number(process.env.PORT || 5780),
  // Postgres connection (in-cluster). Falls back to a local dev DB.
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/hnradio',
  // Legacy JSON store — only read once at boot to migrate into Postgres.
  dataDir: join(__dirname, '..', 'data'),
  dramasFile: join(__dirname, '..', 'data', 'dramas.json'),
}
