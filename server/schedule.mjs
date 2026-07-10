/**
 * Daily top-of-HN sweep. Once a day at 7pm America/Chicago (CST/CDT — the IANA
 * zone handles daylight saving), fetch the top stories from the official HN
 * Firebase API, keep the first 5 with a real discussion (≥10 comments), and
 * kick off a podcast for each. startGeneration() dedupes by (thread, mode), so
 * a story that already has a ready episode is skipped for free.
 *
 * The last-run date persists in settings ('dailyTopLastRun') so a restart
 * during the 19:00 minute can't double-run the sweep. Single replica — no
 * cross-instance locking needed.
 *
 * Disable with HNRADIO_DAILY_TOP=off.
 */
import { startGeneration } from './generate.mjs'
import { getSetting, setSetting } from './store.mjs'

const TZ = 'America/Chicago'
const RUN_AT = '19:00'
const EPISODE_COUNT = 5
const MIN_COMMENTS = 10 // skip barely-discussed stories — the hosts need material
const CANDIDATE_POOL = 30 // top stories to scan for the 5 qualifying threads
const STAGGER_MS = 3 * 60_000 // gap between generation kickoffs, kind to the Story API queue

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Current date + HH:mm in the schedule's timezone. */
function localNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date())
  const get = (t) => parts.find((p) => p.type === t)?.value
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` }
}

/** Top HN stories that actually have a discussion worth performing. */
async function topDiscussedStories() {
  const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')
  if (!res.ok) throw new Error(`topstories.json HTTP ${res.status}`)
  const ids = (await res.json()).slice(0, CANDIDATE_POOL)
  const picked = []
  for (const id of ids) {
    if (picked.length >= EPISODE_COUNT) break
    try {
      const item = await (await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)).json()
      if (item?.type === 'story' && (item.descendants ?? 0) >= MIN_COMMENTS) picked.push(item)
    } catch {
      // skip an unfetchable item; the pool has slack
    }
  }
  return picked
}

async function runDailySweep() {
  const stories = await topDiscussedStories()
  console.log(`[daily] sweeping ${stories.length} top thread(s)`)
  for (const [i, story] of stories.entries()) {
    const url = `https://news.ycombinator.com/item?id=${story.id}`
    let reused = false
    try {
      const result = await startGeneration(url)
      reused = result.reused
      console.log(`[daily] ${reused ? 'already have' : 'started'}: ${story.title}`)
    } catch (err) {
      console.error(`[daily] failed to start ${url}: ${err?.message || err}`)
    }
    if (!reused && i < stories.length - 1) await sleep(STAGGER_MS)
  }
  console.log('[daily] sweep kicked off — episodes will appear as they finish')
}

export function startDailySchedule() {
  if ((process.env.HNRADIO_DAILY_TOP || 'on') === 'off') {
    console.log('[daily] top-of-HN sweep disabled (HNRADIO_DAILY_TOP=off)')
    return
  }
  console.log(`[daily] top-of-HN sweep armed — every day at ${RUN_AT} ${TZ}`)
  setInterval(async () => {
    try {
      const { date, time } = localNow()
      if (time !== RUN_AT) return
      const last = await getSetting('dailyTopLastRun')
      if (last === date) return
      await setSetting('dailyTopLastRun', date) // claim BEFORE running — no double-fire within the minute
      await runDailySweep()
    } catch (err) {
      console.error(`[daily] tick failed: ${err?.message || err}`)
    }
  }, 30_000)
}
