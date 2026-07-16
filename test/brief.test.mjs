import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBrief,
  buildStoryJobArtifactRequests,
  canonicalPinnedVoiceMap,
} from '../worker/brief.mjs'

test('every must-know instruction stays within the Sleeper plan schema limit', () => {
  const brief = buildBrief({ title: 'Test thread', total: 100, points: 200 }, 10)
  const mustKnow = brief.creativeBrief.mustKnowBeforeWriting
  assert.ok(mustKnow.length > 0)
  for (const [index, instruction] of mustKnow.entries()) {
    assert.ok(
      instruction.length <= 220,
      `mustKnowBeforeWriting.${index} is ${instruction.length} characters`,
    )
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
