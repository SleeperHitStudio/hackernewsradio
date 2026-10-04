import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EPISODE_PAGE_TARGET,
  SHOW_NEVER_SAY,
  buildBrief,
  buildStoryJobArtifactRequests,
  canonicalPinnedVoiceMap,
  castCanonCharacters,
  hostForCharacter,
  pageTargetFor,
  staleCastCanonCharacters,
} from '../worker/brief.mjs'

test('performanceNotes fits the artifact-request notes cap (contract test)', () => {
  // performanceNotes rides to the platform as artifactRequests[0].notes
  // (worker/pipeline.mjs), which the Story API caps at 5000 chars. It is a
  // TOP-LEVEL brief field, so the cap sweep below — which only walks target /
  // creativeBrief / styleConstraints — never saw it.
  //
  // 2026-08-18: it reached 6080 chars and every episode died with
  //   `artifactRequests[0]` is invalid: notes - Too big: expected string to
  //   have <=5000 characters
  // while the rest of the suite stayed green. Same failure shape as the 13th
  // mustKnow bullet: a deterministic outage that no test was watching for.
  //
  // The string interpolates pageTarget, so check the whole range rather than
  // one sample.
  for (const pageTarget of [4, 6, 8, 10, 12]) {
    const notes = String(buildBrief({ title: 'x'.repeat(240), total: 5000, points: 9000 }, pageTarget).performanceNotes ?? '')
    assert.ok(
      notes.length <= 5000,
      `performanceNotes is ${notes.length} chars at pageTarget ${pageTarget} (Sleeper cap 5000)`,
    )
  }
})

test('the full brief honors every Sleeper plan-schema cap (contract test)', () => {
  // Mirrors packages/web/src/server/story-plan-schema.ts on the platform:
  //   storyPlanTargetSchema, storyPlanCreativeBriefSchema, storyPlanStyleConstraintsSchema.
  // A violation here is a DETERMINISTIC production outage: every plan request
  // is rejected with a 400 until a fix deploys (2026-07-18: a 13th mustKnow
  // bullet silently killed a whole night's generation).
  const caps = {
    target: { audience: 200, objective: 400, outcome: 400, tone: 120, industry: 120, distributionContext: 300 },
    creativeBrief: {
      installmentLabel: 160, seriesContext: 1200, genre: 160, audience: 240,
      writingStyle: 600, castNotes: 1000, musicStyle: 500, sfxPolicy: 500, replanInstruction: 5000,
    },
    styleConstraints: { preferredVisualStyle: 400, voicePreference: 160, musicPolicy: 300 },
  }
  const arrayCaps = {
    creativeBrief: { comps: [8, 160], mustKnowBeforeWriting: [12, 220] },
    styleConstraints: { forbiddenVisuals: [10, 160], brandSafety: [10, 160] },
  }

  // Exercise the extremes: giant thread + max page target, tiny thread + min.
  const briefs = [
    buildBrief({ title: 'x'.repeat(240), total: 5000, points: 9000 }, 12),
    buildBrief({ title: 't', total: 5, points: 0 }, 4),
  ]

  for (const brief of briefs) {
    assert.ok(String(brief.title).length <= 240, `title is ${String(brief.title).length} chars (cap 240)`)
    for (const [section, fields] of Object.entries(caps)) {
      const obj = brief[section] ?? brief.creativeBrief?.[section] ?? {}
      for (const [field, cap] of Object.entries(fields)) {
        const value = obj[field]
        if (value === undefined || value === null) continue
        assert.ok(
          String(value).length <= cap,
          `${section}.${field} is ${String(value).length} chars (Sleeper cap ${cap})`,
        )
      }
    }
    for (const [section, fields] of Object.entries(arrayCaps)) {
      const obj = brief[section] ?? {}
      for (const [field, [maxItems, maxLen]] of Object.entries(fields)) {
        const value = obj[field]
        if (!Array.isArray(value)) continue
        assert.ok(value.length <= maxItems, `${section}.${field} has ${value.length} items (Sleeper cap ${maxItems})`)
        for (const [index, entry] of value.entries()) {
          assert.ok(
            String(entry).length <= maxLen,
            `${section}.${field}[${index}] is ${String(entry).length} chars (Sleeper cap ${maxLen})`,
          )
        }
      }
    }
  }
})

const completePinnedVoices = {
  GARY: { voiceId: 'voice-gary', voiceName: 'spoofed Gary', provider: 'cartesia' },
  MAEVE: { voiceId: 'voice-maeve', gender: 'spoofed' },
  OBI: { voiceId: 'voice-obi', provider: 'hume' },
  GRUNER: { voiceId: 'voice-gruner', voiceName: 'spoofed Gruner' },
  GUEST: { voiceId: 'voice-guest' },
}

test('complete pinned cast is sent canonically with voiceId only', () => {
  assert.deepEqual(canonicalPinnedVoiceMap(completePinnedVoices), {
    GARY: { voiceId: 'voice-gary' },
    MAEVE: { voiceId: 'voice-maeve' },
    OBI: { voiceId: 'voice-obi' },
    GRUNER: { voiceId: 'voice-gruner' },
  })

  assert.deepEqual(buildStoryJobArtifactRequests({
    pinnedVoices: completePinnedVoices,
    notes: 'Keep it fast.',
  }), [{
    type: 'table_read',
    narrationPolicy: 'suppress',
    punchUp: true,
    neverSay: ['goddamn', 'Jesus', 'Christ'],
    firstLineClean: true,
    deferMusic: true,
    deferAudioRender: true,
    notes: 'Keep it fast.',
    voiceMap: {
      GARY: { voiceId: 'voice-gary' },
      MAEVE: { voiceId: 'voice-maeve' },
      OBI: { voiceId: 'voice-obi' },
      GRUNER: { voiceId: 'voice-gruner' },
    },
  }])
})

test('missing or incomplete pinned cast preserves the existing assignment request', () => {
  for (const pinnedVoices of [
    null,
    { ...completePinnedVoices, GRUNER: undefined },
    { ...completePinnedVoices, MAEVE: { voiceId: '   ' } },
  ]) {
    assert.deepEqual(buildStoryJobArtifactRequests({
      pinnedVoices,
      notes: 'Keep it fast.',
    }), [{
      type: 'table_read',
      narrationPolicy: 'suppress',
      punchUp: true,
      neverSay: ['goddamn', 'Jesus', 'Christ'],
      firstLineClean: true,
      deferMusic: true,
      deferAudioRender: true,
      notes: 'Keep it fast.',
    }])
  }
})

test('resume and repair of an existing artifact never creates a cast-bearing job request', () => {
  assert.equal(buildStoryJobArtifactRequests({
    existingArtifactId: 'artifact-existing',
    pinnedVoices: completePinnedVoices,
    notes: 'This must not be sent.',
  }), null)
})

test('every new episode asks for the guarded punch-up, with the show\'s hard lines', () => {
  // The comedy rewrite (owner, 2026-10-02: "much funnier but still on brand, and a bit more
  // swearing"). The platform's scene-by-scene writer drowns notes in ~55K tokens of context, so the
  // swearing only arrives in a punch-up pass that edits each written scene. Its guard reverts a scene
  // that adds a neverSay term, so the hard lines ride on every request, not in a prompt alone.
  for (const pinnedVoices of [null, completePinnedVoices]) {
    const [request] = buildStoryJobArtifactRequests({ pinnedVoices, notes: 'x' })
    assert.equal(request.punchUp, true)
    assert.deepEqual(request.neverSay, ['goddamn', 'Jesus', 'Christ'])
    // And it never opens on a swear (episode 3 of the canary did): the guard keeps the first spoken line clean.
    assert.equal(request.firstLineClean, true)
  }
  // A request gets its own copy: nothing downstream can edit the show's list.
  assert.throws(() => { SHOW_NEVER_SAY.push('heck') })
  const [a] = buildStoryJobArtifactRequests({ notes: 'x' })
  a.neverSay.push('heck')
  assert.deepEqual(buildStoryJobArtifactRequests({ notes: 'x' })[0].neverSay, ['goddamn', 'Jesus', 'Christ'])
  // The platform caps the list at 20 terms of at most 40 characters.
  assert.ok(SHOW_NEVER_SAY.length <= 20 && SHOW_NEVER_SAY.every((term) => term.length <= 40))
})

test('every episode is about 9 pages (about 12 minutes on air), whatever the thread\'s engagement', () => {
  // Owner, 2026-10-04: "~12 minutes", which the cast plays from about 9 pages (12-page episodes ran
  // 14.5-17 minutes). The plan's pageTarget is the one length number: the platform derives the writer's
  // length line and the coverage gate's band from it, so the brief's own length line must agree.
  assert.equal(EPISODE_PAGE_TARGET, 9)
  for (const thread of [{ total: 5, points: 0 }, { total: 300, points: 400 }, { total: 5000, points: 9000 }]) {
    assert.equal(pageTargetFor(thread), 9)
  }
  const brief = buildBrief({ title: 't', total: 5, points: 0 }, pageTargetFor({ total: 5, points: 0 }))
  assert.equal(brief.creativeBrief.pageTarget, 9)
  assert.match(brief.performanceNotes, /LENGTH: about 9 pages, roughly 1,650 spoken words\./)
  // Pages and words only: a runtime here would contradict the platform's page-a-minute length line.
  assert.doesNotMatch(brief.performanceNotes, /\bminutes?\b/i)
})

test('the brief asks for a very funny, sweary show and never rations the swearing', () => {
  // The old brief and Bible called the swearing "a SPICE" and stopped every bit after one line; the
  // shows averaged 2 swears and ~10 "that's not X, that's Y" reframes. The brief now leads with the joke.
  const brief = buildBrief({ title: 't', total: 500, points: 100 }, 12)
  const everything = JSON.stringify(brief)
  assert.doesNotMatch(everything, /\bspice\b/i)
  assert.match(brief.performanceNotes, /^THIS IS A COMEDY\./)
  assert.match(brief.performanceNotes, /at least twelve an episode, more than one a page, SPREAD across all four/)
  assert.match(brief.performanceNotes, /Never "goddamn", "Jesus" or "Christ"\. Never at a private commenter as a person/)
  assert.match(brief.creativeBrief.writingStyle, /^COMEDY FIRST/)
  const mustKnow = brief.creativeBrief.mustKnowBeforeWriting.join('\n')
  assert.match(mustKnow, /THE LADDER, 3\+ per episode/)
  assert.match(mustKnow, /never "goddamn", "Jesus" or "Christ"; never at a private commenter as a person/)
  assert.match(mustKnow, /SWEARS, 12\+, SPREAD/)
  // Each host has one joke engine, and none is shared.
  for (const host of ['GARY', 'MAEVE', 'OBI', 'GRUNER']) assert.ok(brief.creativeBrief.castNotes.includes(host))
  assert.match(brief.creativeBrief.castNotes, /FOUR JOKE MACHINES, NEVER SHARED/)
})

test('every generated job defers the soundtrack — the jazz theme is banked, not rendered', () => {
  // shapeMusic() overwrites the bookends with the banked theme and mutes every
  // middle bed, so a coverage pass renders 3-4 clips nobody ever hears.
  for (const pinnedVoices of [null, completePinnedVoices]) {
    const [request] = buildStoryJobArtifactRequests({ pinnedVoices, notes: 'x' })
    assert.equal(request.deferMusic, true)
  }
})

test('the brief never invites a fifth speaking character', () => {
  // The cast is four voices and the pinned voiceMap covers exactly those four.
  // castNotes used to end with "plus at most ONE optional guest voicing the
  // thread's most notable commenter" — so the writer was being ASKED for a
  // speaker the show cannot voice. The platform then refused the whole job
  // ("Supply every speaking character"), which classified as a contract
  // failure, opened the generation circuit and halted a night at 1 of 5.
  const brief = buildBrief({ title: 't', total: 500, points: 100 }, 8)
  const notes = brief.creativeBrief.castNotes

  assert.doesNotMatch(notes, /optional guest|guest voicing|ONE guest/i)
  assert.match(notes, /ONLY SPEAKING CHARACTERS/i)
  // Commenters still belong in the show — quoted inside a host's line, not
  // handed one. Dropping the guest must not read as "ignore the thread".
  assert.match(notes, /QUOTED BY a host/i)
})

test('every host the brief names is one the pinned voice map can cast', () => {
  // The failure mode is a name in the script with no voice behind it. Any host
  // named in castNotes must therefore resolve through hostForCharacter, or the
  // brief is promising a voice that does not exist.
  const notes = buildBrief({ title: 't', total: 5, points: 1 }, 4).creativeBrief.castNotes
  for (const name of ['GARY', 'MAEVE', 'OBI', 'GRUNER']) {
    assert.ok(notes.includes(name), `castNotes should name ${name}`)
    assert.ok(hostForCharacter(name), `${name} must resolve to a pinned host`)
  }
})

const PINNED_FOUR = {
  GARY: { voiceId: 'v_gary', voiceName: 'Gary', provider: 'elevenlabs' },
  maeve: { voiceId: 'v_maeve', provider: 'elevenlabs' },
  OBI: { voiceId: 'v_obi' },
  GRUNER: { voiceId: 'v_gruner', provider: 'hume' },
}

test('the cast canon carries each host\'s portrait and pinned voice, and nothing the strict schema refuses', () => {
  const characters = castCanonCharacters(PINNED_FOUR)
  assert.deepEqual(characters, [
    { name: 'GARY', avatarUrl: 'https://hnradio.net/avatars/gary.png', voiceId: 'v_gary', voiceProvider: 'elevenlabs' },
    { name: 'MAEVE', avatarUrl: 'https://hnradio.net/avatars/maeve.png', voiceId: 'v_maeve', voiceProvider: 'elevenlabs' },
    { name: 'OBI', avatarUrl: 'https://hnradio.net/avatars/obi.png', voiceId: 'v_obi' },
    { name: 'GRUNER', avatarUrl: 'https://hnradio.net/avatars/gruner.png', voiceId: 'v_gruner', voiceProvider: 'hume' },
  ])
  const allowed = new Set(['name', 'avatarUrl', 'voiceId', 'voiceProvider'])
  for (const character of characters) {
    for (const key of Object.keys(character)) assert.ok(allowed.has(key), `${key} is not a cast canon field HNR writes`)
  }
})

test('before any voice is pinned the canon still gets the portraits', () => {
  assert.deepEqual(castCanonCharacters(null).map((c) => Object.keys(c)), Array(4).fill(['name', 'avatarUrl']))
})

test('a current canon writes nothing; a missing voice rewrites only that host', () => {
  const desired = castCanonCharacters(PINNED_FOUR)
  const stored = {
    content: {
      characters: desired.map((c) => ({ ...c, bodyFigureUrl: 'https://files.example/body.png' })),
    },
  }
  assert.deepEqual(staleCastCanonCharacters(stored, desired), [], 'extra stored fields (bodies, sheets) do not count')

  const noGrunerVoice = structuredClone(stored)
  delete noGrunerVoice.content.characters[3].voiceId
  assert.deepEqual(staleCastCanonCharacters(noGrunerVoice, desired).map((c) => c.name), ['GRUNER'])
})

test('a host stored under a full name with the cue name as an alias is the same person', () => {
  const desired = castCanonCharacters({ GARY: { voiceId: 'v_gary' } }).filter((c) => c.name === 'GARY')
  const stored = {
    content: {
      characters: [{ name: 'Gary Bauxlite', aliases: ['gary'], avatarUrl: 'https://hnradio.net/avatars/gary.png', voiceId: 'v_gary' }],
    },
  }
  assert.deepEqual(staleCastCanonCharacters(stored, desired), [])
  assert.deepEqual(staleCastCanonCharacters(null, desired).map((c) => c.name), ['GARY'], 'an empty canon needs every host')
})

test('the swearing is spread across all four hosts, each with an amount and a way of their own', () => {
  // Owner, 2026-10-04: "spread the swearing across hosts", keeping the total. On the canary Obi said about
  // half of every episode's swears (4/13, 7/13, 10/22, 6/9) and Maeve 1-3, because the brief and the Bible
  // made Obi the profane one with no amount for anyone. Shares written as "about N" and "Obi at most 3"
  // spread it but read as ceilings: the first episode swore 8 times (Gruner 4, Gary 2, Obi 1, Maeve 1)
  // against a median of 13. So each host has a FLOOR, only Obi a ceiling, and the total a floor of twelve.
  const brief = buildBrief({ title: 't', total: 500, points: 100 }, 9)
  const swearing = brief.performanceNotes.split('\n').find((line) => line.startsWith('SWEARING:'))
  assert.ok(swearing, 'the notes have a SWEARING paragraph')
  const shares = { GARY: /GARY, four or more: in panicked spirals/, GRUNER: /GRUNER, three or more: in Russian/, OBI: /OBI, two or three and never more: one precise compound insult/, MAEVE: /MAEVE, two or three: in dead monotone/ }
  for (const [host, share] of Object.entries(shares)) assert.match(swearing, share, `${host} has an amount and a way`)
  assert.match(swearing, /no host carries it, and every host swears at least twice/)
  // Floors, not targets: nothing but Obi's share reads as a ceiling.
  assert.doesNotMatch(swearing, /\babout (two|three|four|twelve)\b/)
  // The planner's bullet says the same split, and Obi's feud with Gary no longer asks for profanity.
  const mustKnow = brief.creativeBrief.mustKnowBeforeWriting
  assert.ok(mustKnow.some((line) => /Gary 4\+ in spirals, Gruner 3\+ in Russian, Maeve 2-3 flat, Obi 2-3 max/.test(line)))
  const feud = mustKnow.find((line) => line.startsWith('OBI GOES FOR GARY'))
  assert.doesNotMatch(feud, /profane/)
  assert.match(brief.creativeBrief.writingStyle, /swearing about once a page, from all four/)
})

test('the brief asks for four to six overlaps an episode, written so the platform keeps them', () => {
  // Owner, 2026-10-04: more crosstalk, 4-6 overlaps an episode within the 30%-per-scene cap (episodes
  // ran 1-3). The notes are repeated after every scene's rules, so the ask is per scene, which a
  // scene writer can act on; an episode-wide count only ever produced one or two. The platform drops
  // a marker whose previous line is not spoken (an action line or a cue between them), so the brief
  // says the cut-in comes directly after the line it cuts.
  const brief = buildBrief({ title: 't', total: 500, points: 100 }, 9)
  const crosstalk = brief.performanceNotes.split('\n').find((line) => line.startsWith('CROSSTALK:'))
  assert.ok(crosstalk, 'the notes have a CROSSTALK paragraph')
  assert.match(crosstalk, /every scene after the cold open has one \(OVERLAPPING\) line, a long scene two: four to six an episode/)
  assert.match(crosstalk, /comes DIRECTLY after it: no action line or sound cue between them/)
  assert.match(crosstalk, /never a quote, a handle, a number or the punchline word/)
  // One or two in a scene of 15-25 lines is well inside the platform's 30%-per-scene warning.
  assert.doesNotMatch(crosstalk, /three|every line/i)
  assert.ok(brief.creativeBrief.mustKnowBeforeWriting.some((line) => /the top rung CUTS IN \(OVERLAPPING\)/.test(line)))
})

test('the planner is told the hosts speak on Cartesia, never Hume', () => {
  // Hume's TTS ends 2026-11-13 and the hosts moved to their Cartesia clones on 2026-10-04. The
  // preference only reaches a character the pins don't cover, and must never steer one onto Hume.
  const brief = buildBrief({ title: 't', total: 500, points: 100 }, 9)
  assert.match(brief.styleConstraints.voicePreference, /^Prefer Cartesia voices/)
  assert.doesNotMatch(JSON.stringify(brief), /\bHume\b/i)
})
