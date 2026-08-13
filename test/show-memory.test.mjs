import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SHOW_MEMORY_DEPTH,
  appendMemory,
  buildSeriesContext,
  extractEpisodeMemory,
  SERIES_BIBLE_MAX_EPISODES,
  trimBibleEpisodes,
} from '../worker/show-memory.mjs'

const SCRIPT = `
GARY: Look, I ran a company called Grout. B2B tile contractors. It had users.
OBI: It had four users and a lawsuit.
MAEVE: This is the Hanseatic League again. A trading bloc that outlived its own charter.
MAEVE: If they churned, they were never elected.
OBI: (reads from logbook) 14:02. Founder claims uptime. Uptime disagrees.
GARY: Note for the next Gary — do not take the meeting on a Friday.
`

test('an episode records which rotating bits it actually spent', () => {
  const memory = extractEpisodeMemory(SCRIPT, { hnId: '123', title: 'A thread' })
  assert.equal(memory.garyVenture, 'Grout')
  assert.equal(memory.maeveArc, 'Hanseatic League')
  assert.equal(memory.maeveDoctrine, 'unconditional election')
  assert.ok(memory.obiBits.includes('logbook'))
  assert.ok(memory.showBits.includes('notes for next Gary'))
  assert.deepEqual(memory.violations, [])
})

test('a retired reference is surfaced as a canon violation', () => {
  // Maeve is banned from these; the show should be able to notice a relapse.
  const memory = extractEpisodeMemory('MAEVE: It is the browser wars, but for agents.')
  assert.deepEqual(memory.violations, ['browser wars'])
})

test('an empty or missing script does not throw', () => {
  const memory = extractEpisodeMemory('', {})
  assert.equal(memory.garyVenture, null)
  assert.deepEqual(memory.obiBits, [])
  assert.equal(extractEpisodeMemory(null).maeveArc, null)
})

test('memory keeps the most recent episodes and drops the rest', () => {
  let memory = []
  for (let i = 0; i < SHOW_MEMORY_DEPTH + 5; i++) {
    memory = appendMemory(memory, { hnId: String(i), garyVenture: 'Grout' })
  }
  assert.equal(memory.length, SHOW_MEMORY_DEPTH)
  assert.equal(memory[0].hnId, String(SHOW_MEMORY_DEPTH + 4), 'newest first')
})

test('re-running a thread replaces its entry instead of double-counting', () => {
  // Repairs and re-rolls are routine; a bit that aired once must count once.
  let memory = appendMemory([], { hnId: '42', garyVenture: 'Thermal' })
  memory = appendMemory(memory, { hnId: '43', garyVenture: 'Grout' })
  memory = appendMemory(memory, { hnId: '42', garyVenture: 'Pareto' })
  assert.equal(memory.length, 2)
  assert.equal(memory.filter((e) => e.hnId === '42').length, 1)
  assert.equal(memory[0].garyVenture, 'Pareto')
})

test('the series context tells the writer what NOT to reuse', () => {
  const context = buildSeriesContext([
    { hnId: '1', title: 'Thread one', garyVenture: 'Grout', maeveArc: 'Hanseatic League', maeveDoctrine: 'unconditional election', obiBits: ['logbook'], showBits: [] },
    { hnId: '2', garyVenture: 'Thermal', maeveArc: 'whale oil', maeveDoctrine: 'total depravity', obiBits: ['roll call'], showBits: [] },
  ])
  assert.match(context, /Do NOT reuse/)
  assert.match(context, /Grout/)
  assert.match(context, /Thermal/)
  assert.match(context, /Hanseatic League/)
  assert.match(context, /whale oil/)
  assert.match(context, /Thread one/)
})

test('the operator thread reports how far it has escalated', () => {
  const none = buildSeriesContext([{ hnId: '1', showBits: [], obiBits: [] }])
  assert.match(none, /has not come up/)

  const twice = buildSeriesContext([
    { hnId: '1', showBits: ['the operator'], obiBits: [] },
    { hnId: '2', showBits: ['the operator'], obiBits: [] },
    { hnId: '3', showBits: [], obiBits: [] },
  ])
  assert.match(twice, /surfaced in 2 of the last 3/)
  assert.match(twice, /escalating/)
})

test('the series context never exceeds the API cap that would 400 the plan', () => {
  // seriesContext is capped at 1200 chars; over it, the whole request fails.
  const fat = Array.from({ length: SHOW_MEMORY_DEPTH }, (_, i) => ({
    hnId: String(i),
    title: 'A very long episode title that goes on '.repeat(3),
    garyVenture: 'Bauxlite',
    maeveArc: 'rural electrification',
    maeveDoctrine: 'unconditional election',
    obiBits: ['logbook', 'roll call', 'episode postmortem'],
    showBits: ['the operator'],
  }))
  const context = buildSeriesContext(fat)
  assert.ok(context.length <= 1200, `was ${context.length}`)
  // Even when trimmed it must keep the instruction and the escalation state.
  assert.match(context, /Do NOT reuse/)
  assert.match(context, /operator/)
})

test('no memory yet means no series context at all', () => {
  assert.equal(buildSeriesContext([]), null)
  assert.equal(buildSeriesContext(null), null)
})

const produced = (id) => ({ id: `u${id}`, label: `HN ${id}`, title: `Story ${id}`, status: 'produced' })
const canon = (name) => ({ id: `c-${name}`, label: name, title: name, status: 'planned' })

test('an episode log under the cap is left exactly as it is', () => {
  const list = [canon('THE FLICKER'), produced(1), produced(2)]
  assert.deepEqual(trimBibleEpisodes(list, 100), list)
})

test('a full episode log drops its oldest produced rows to make room', () => {
  // The platform rejects the whole patch at >100 entries, so without this the
  // log silently stops recording once the show has produced 100 episodes.
  const list = [...Array.from({ length: 102 }, (_, i) => produced(i + 1))]
  const trimmed = trimBibleEpisodes(list, 100)

  assert.equal(trimmed.length, 100)
  assert.equal(trimmed[0].label, 'HN 3', 'the two oldest went')
  assert.equal(trimmed.at(-1).label, 'HN 102', 'the episode just appended survives')
})

test('authored show canon is never dropped to make room', () => {
  // The same array holds the show's canonical episodes. Those are authored, not
  // generated, and deleting one to fit a produced-episode row would lose canon
  // that nothing else in the system can reconstruct.
  const list = [canon('THE FLICKER'), canon('GARY ORIGIN'), ...Array.from({ length: 100 }, (_, i) => produced(i + 1))]
  const trimmed = trimBibleEpisodes(list, 100)

  assert.equal(trimmed.length, 100)
  assert.deepEqual(
    trimmed.filter((e) => e.status === 'planned').map((e) => e.label),
    ['THE FLICKER', 'GARY ORIGIN'],
    'both canon entries survive',
  )
  assert.equal(trimmed[2].label, 'HN 3', 'produced rows absorbed the whole trim')
})

test('a log full of canon is returned untouched rather than trimmed', () => {
  // Failing the append is recoverable and loud. Deleting canon to satisfy it is
  // neither, so the trim refuses when it cannot make room from its own rows.
  const list = Array.from({ length: 105 }, (_, i) => canon(`CANON ${i}`))
  assert.deepEqual(trimBibleEpisodes(list, 100), list)
})

test('the cap matches the limit the platform actually enforces', () => {
  // The rejection reads "Too big: expected array to have <=100 items".
  assert.equal(SERIES_BIBLE_MAX_EPISODES, 100)
})
