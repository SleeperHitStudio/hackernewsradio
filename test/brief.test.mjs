import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBrief,
  buildStoryJobArtifactRequests,
  canonicalPinnedVoiceMap,
  hostForCharacter,
} from '../worker/brief.mjs'

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
    deferMusic: true,
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
      deferMusic: true,
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
