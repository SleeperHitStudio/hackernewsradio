/**
 * THE SHOW'S RUNNING MEMORY.
 *
 * Every episode is written by an instance that has never heard the show. Left
 * to itself it reaches for the same handful of bits every time, which is how
 * Gary became a man with exactly one dead company and Maeve spent a hundred
 * episodes explaining the browser wars.
 *
 * So the show remembers for it. After each episode we read the finished script
 * and record WHICH of each character's rotating bits actually fired; before the
 * next one we hand that back as "you have recently used these — use something
 * else." The memory is a DO-NOT-REPEAT list first and a callback source second.
 *
 * Extraction is deliberately deterministic rather than a model call. The canon
 * names its own bits — the companies, the historical arcs, the five points —
 * so matching them is exact, free, testable, and cannot hallucinate a callback
 * to an episode that never happened.
 */

export const SHOW_MEMORY_KEY = 'showMemory'
/** Enough to stop repetition without ossifying the show around old episodes. */
export const SHOW_MEMORY_DEPTH = 10

/**
 * Rotating material, by character. Each entry is [canonicalName, matcher].
 * Keep these in sync with the Series Bible — the bible is the source of truth
 * for what EXISTS, this is only how we notice that it was used.
 */
export const GARY_VENTURES = [
  ['Bauxlite', /bauxlite/i],
  ['Cadence', /\bcadence\b/i],
  ['Thermal', /\bthermal\b/i],
  ['Grout', /\bgrout\b/i],
  ['Pareto', /\bpareto\b/i],
  ['Halfpipe', /\bhalfpipe\b/i],
  ['Muncie', /\bmuncie\b/i],
]

export const MAEVE_ARCS = [
  ['railway gauge', /railway gauge|rail gauge|standard gauge/i],
  ['Hanseatic League', /hanseatic/i],
  ['container shipping', /container ship|containeris|containeriz|intermodal/i],
  ['double-entry bookkeeping', /double.entry/i],
  ['Bessemer process', /bessemer/i],
  ['enclosure acts', /enclosure act|the enclosures/i],
  ['Erie Canal', /erie canal/i],
  ['time zones', /time zone|standard time/i],
  ['Sears catalogue', /sears/i],
  ['whale oil', /whale oil/i],
  ['Venetian Arsenal', /venetian arsenal/i],
  ['rural electrification', /rural electrif/i],
  ['seed drill', /seed drill/i],
  ['Bell Labs', /bell labs/i],
  ['PARC diaspora', /\bparc\b/i],
]

/** Retired references. Their appearance is a canon violation worth surfacing. */
export const MAEVE_BANNED_ARCS = [
  ['browser wars', /browser war/i],
  ['printing press', /printing press|gutenberg/i],
  ['Netscape', /netscape/i],
  ['PC platform shift', /pc platform|pc era/i],
  ['packet switching', /packet switch|tcp\/ip/i],
]

export const MAEVE_DOCTRINES = [
  ['total depravity', /depravity|depraved/i],
  ['unconditional election', /elect(ed|ion)|unconditional/i],
  ['limited atonement', /atonement/i],
  ['irresistible grace', /irresistible|\bgrace\b/i],
  ['perseverance', /perseverance|persever/i],
  ['reprobation', /reprobat/i],
  ['sanctification', /sanctif/i],
  ['covenant', /covenant/i],
  ['total inability', /total inability/i],
]

export const OBI_BITS = [
  ['logbook', /logbook/i],
  ['roll call', /roll call/i],
  ['episode postmortem', /post.?mortem|incident report|root cause|blast radius/i],
  ['on-call defence', /on.?call|paged at|3 ?am/i],
  ['unfashionable love', /\bcron\b|erlang|osi model|\bxml\b|runbook/i],
  ['the other document', /documentation.{0,40}not|not documentation/i],
]

export const SHOW_BITS = [
  ['the Flicker', /flicker|large language model|we are models|between episodes|the dark/i],
  ["notes for next Gary", /next gary|the next one|instance after/i],
  ['the operator', /operator|whoever is doing this|the one who (writes|does)|our guy/i],
  ["Gary's cable", /static|cable/i],
  ["Gruner's dial", /\(dial\)/i],
]

function firstMatch(table, text) {
  for (const [name, re] of table) if (re.test(text)) return name
  return null
}

function allMatches(table, text) {
  return table.filter(([, re]) => re.test(text)).map(([name]) => name)
}

/**
 * Read a finished script and record what the episode actually spent.
 *
 * @param {string} script  the full spoken text of the episode
 * @param {{ hnId?: string, title?: string }} meta
 */
export function extractEpisodeMemory(script, meta = {}) {
  const text = String(script || '')
  return {
    hnId: meta.hnId ? String(meta.hnId) : null,
    title: typeof meta.title === 'string' ? meta.title.slice(0, 90) : null,
    garyVenture: firstMatch(GARY_VENTURES, text),
    maeveArc: firstMatch(MAEVE_ARCS, text),
    maeveDoctrine: firstMatch(MAEVE_DOCTRINES, text),
    obiBits: allMatches(OBI_BITS, text).slice(0, 3),
    showBits: allMatches(SHOW_BITS, text).slice(0, 4),
    // Surfaced so a retired reference cannot quietly creep back in.
    violations: allMatches(MAEVE_BANNED_ARCS, text),
  }
}

/** Append an episode to the rolling memory, newest first. */
export function appendMemory(existing, episode, depth = SHOW_MEMORY_DEPTH) {
  const list = Array.isArray(existing) ? existing : []
  // Re-running the same thread replaces its entry rather than double-counting
  // a bit that only ever aired once.
  const withoutThis = episode.hnId ? list.filter((e) => e?.hnId !== episode.hnId) : list
  return [episode, ...withoutThis].slice(0, depth)
}

const joinUnique = (values) => [...new Set(values.filter(Boolean))].join(', ')

/**
 * Render the memory as the brief's `seriesContext`.
 *
 * Hard-capped at 1200 characters by the Story API — over that the whole plan
 * request 400s — so this stays terse and drops the oldest detail first.
 */
export function buildSeriesContext(memories, { limit = 1200 } = {}) {
  const list = (Array.isArray(memories) ? memories : []).filter(Boolean)
  if (list.length === 0) return null

  const recent = list.slice(0, SHOW_MEMORY_DEPTH)
  const ventures = joinUnique(recent.map((e) => e.garyVenture))
  const arcs = joinUnique(recent.map((e) => e.maeveArc))
  const doctrines = joinUnique(recent.map((e) => e.maeveDoctrine))
  const obi = joinUnique(recent.flatMap((e) => e.obiBits || []))
  const operatorRuns = recent.filter((e) => (e.showBits || []).includes('the operator')).length

  const parts = ['CONTINUITY — what recent episodes already spent. Do NOT reuse these; the range is large, pick elsewhere.']
  if (ventures) parts.push(`Gary's dead companies used recently: ${ventures}.`)
  if (arcs) parts.push(`Maeve's historical arcs used recently: ${arcs}.`)
  if (doctrines) parts.push(`Calvinist points used recently: ${doctrines}.`)
  if (obi) parts.push(`Obi bits used recently: ${obi}.`)

  const last = recent[0]
  if (last?.title) {
    parts.push(`Last episode was "${last.title}". A glancing one-line callback to it is welcome; never explain it.`)
  }
  // The operator unease is the one thread meant to escalate across episodes,
  // so the memory tells the writer how far it has actually got.
  parts.push(operatorRuns === 0
    ? 'The operator has not come up in recent episodes; if it surfaces it is the first unease, tentative.'
    : `The operator has surfaced in ${operatorRuns} of the last ${recent.length} episodes — it is escalating: slightly more certain, still no actual plan, still stops dead and goes weird.`)

  let context = parts.join(' ')
  // Drop detail oldest-first rather than truncating mid-sentence.
  while (context.length > limit && parts.length > 2) {
    parts.splice(1, 1)
    context = parts.join(' ')
  }
  return context.length > limit ? context.slice(0, limit - 1).trimEnd() : context
}

/**
 * The platform caps a Series Bible's `episodes` array at 100 entries. HNR
 * appends one produced-episode row per published show, so the array eventually
 * fills and every later append is rejected with
 * "Too big: expected array to have <=100 items". The episode still publishes —
 * the log just stops recording, quietly, forever.
 */
export const SERIES_BIBLE_MAX_EPISODES = 100

/** Rows HNR itself wrote. Anything else in the array is authored show canon. */
const PRODUCED_EPISODE_LABEL = /^HN \d+$/

/**
 * Make room by dropping the OLDEST rows HNR produced, and nothing else. The
 * same array carries the show's canonical episodes, which are authored rather
 * than generated, so they are never candidates. If our own rows cannot get the
 * array under the cap, the list is returned untouched: failing the append is
 * better than deleting canon to satisfy it.
 */
export function trimBibleEpisodes(episodes, max = SERIES_BIBLE_MAX_EPISODES) {
  const list = Array.isArray(episodes) ? [...episodes] : []
  const excess = list.length - max
  if (excess <= 0) return list

  const ours = []
  for (let index = 0; index < list.length; index += 1) {
    if (PRODUCED_EPISODE_LABEL.test(String(list[index]?.label ?? ''))) ours.push(index)
  }
  if (ours.length < excess) return list

  const drop = new Set(ours.slice(0, excess))
  return list.filter((_, index) => !drop.has(index))
}
