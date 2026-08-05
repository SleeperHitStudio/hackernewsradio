import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HNR_SFX_CANON,
  HNR_SFX_PROMPTS,
  enforceSfxCanon,
  resolveSfxCue,
} from '../worker/sfx-canon.mjs'

/** Cue labels this show actually produced, straight out of the SFX inventory. */
const REAL_ROGUE_CUES = [
  // Break the Bible's "no musical/instrument sounds as SFX" rule outright.
  'Rimshot', 'rimshot', 'record scratch', 'Record Scratch', 'Record scratch',
  'Synth sting', 'Jazz Sting', 'air horn', 'Applause', 'applause',
  'Applause sting', 'Applause Sting',
  // Breaks "NO screeching, squealing, feedback... harsh high-pitched sounds".
  'alarm blaring',
  // Furniture from a different show.
  'Glass Rattle', 'Bottle rattle', 'door slam', 'Door Bang', 'Crowd murmur',
  'Balloon deflation', 'Irregular final clock', 'Dossier thud', 'Ceramic clatter',
]

test('every rogue cue the show produced is switched off', () => {
  for (const label of REAL_ROGUE_CUES) {
    assert.equal(resolveSfxCue({ label, prompt: '' }), null, `${label} must not survive`)
  }
})

test('a rimshot stays banned even when described as something innocuous', () => {
  // The label is the model's word for it; the prompt is what it would render.
  assert.equal(resolveSfxCue({ label: 'Beat', prompt: 'a snare drum rimshot for the punchline' }), null)
})

test("Gary's cable gag always resolves to the one banked sound", () => {
  // 44 distinct wordings existed in production. All of them are this now.
  for (const label of [
    'Static Crackle', 'Radio static', 'Cable crackle', 'Cable Snap', 'Cable hum',
    'Cable pop and radio static', 'cable yank and radio static hiss', 'soft crackle',
    'mic cable clatter and click', 'Static', 'Cable Pop',
  ]) {
    const entry = resolveSfxCue({ label, prompt: '' })
    assert.ok(entry, `${label} should resolve`)
    assert.equal(entry.label, 'Cable pop and static crackle')
    assert.equal(entry.prompt, 'sharp cable pop followed by a brief static crackle')
  }
})

test("every click, including Gruner's throat dial, becomes Dial Click", () => {
  for (const label of ['Mic Click', 'Relay Click', 'UI Click', 'Pen click', 'Light click', 'Dial Turn']) {
    const entry = resolveSfxCue({ label, prompt: '' })
    assert.ok(entry, `${label} should resolve`)
    assert.equal(entry.label, 'Dial Click')
  }
})

test('keyboard cues collapse to one, but a key tap keeps its own sound', () => {
  for (const label of ['keyboard clatter', 'Keys clatter', 'Keystrokes', 'Keyboard Enter', 'Keys Stop Abruptly']) {
    assert.equal(resolveSfxCue({ label, prompt: '' }).label, 'Keyboard clatter', label)
  }
  // Specific beats general: this must not be swallowed by the keyboard rule.
  assert.equal(resolveSfxCue({ label: 'Key Tap', prompt: '' }).label, 'Key Tap')
})

test('the closing stamp is distinguished from the cold-open stamp', () => {
  assert.equal(resolveSfxCue({ label: 'Cold-open stamp', prompt: '' }).label, 'Cold-open stamp')
  assert.equal(resolveSfxCue({ label: 'Stamp Impact', prompt: '' }).label, 'Cold-open stamp')
  assert.equal(resolveSfxCue({ label: 'Final verdict stamp', prompt: '' }).label, 'Final verdict stamp')
  assert.equal(resolveSfxCue({ label: 'Evidence stamp', prompt: 'the closing verdict' }).label, 'Final verdict stamp')
})

test('paper and sigh cues collapse to their single sounds', () => {
  for (const label of ['Page flip', 'Paper turn', 'Paper spill', 'Page turn']) {
    assert.equal(resolveSfxCue({ label, prompt: '' }).label, 'Page turn', label)
  }
  for (const label of ['Sigh', 'Soft Sigh', 'Exhale', 'Throat clear', 'Broken Inhale — Bald Man']) {
    assert.equal(resolveSfxCue({ label, prompt: '' }).label, 'Sigh', label)
  }
})

test('the whitelist is exactly eleven sounds with unique prompts', () => {
  assert.equal(HNR_SFX_CANON.length, 11)
  assert.equal(new Set(HNR_SFX_PROMPTS).size, 11, 'a shared prompt would collapse two sounds into one')
  assert.equal(new Set(HNR_SFX_CANON.map((e) => e.key)).size, 11)
})

test('a canonical cue is left completely alone', async () => {
  // Reusing the banked asset depends on the prompt matching byte for byte, so
  // an already-correct cue must not be rewritten (or re-rendered) on a repair.
  const calls = []
  const sh = {
    listSfxCues: async () => [
      { id: 'c1', label: 'Dial Click', prompt: 'heavy click of throat dial', isDisabled: false },
    ],
    updateSfxCue: async (...args) => { calls.push(args) },
  }
  const summary = await enforceSfxCanon(sh, 'art_1')
  assert.deepEqual(calls, [])
  assert.deepEqual(summary, { total: 1, kept: 1, disabled: 0, byKey: { click: 1 } })
})

test('enforcement rewrites what it can and disables the rest', async () => {
  const updates = []
  const sh = {
    listSfxCues: async () => [
      { id: 'c1', label: 'Static Crackle', prompt: 'harsh static', isDisabled: false },
      { id: 'c2', label: 'Rimshot', prompt: 'ba dum tss', isDisabled: false },
      { id: 'c3', label: 'Neon sign buzz', prompt: 'wrong prompt', isDisabled: false },
      { id: 'c4', label: 'Balloon deflation', prompt: '', isDisabled: true },
    ],
    updateSfxCue: async (_artifact, id, fields) => { updates.push({ id, ...fields }) },
  }
  const summary = await enforceSfxCanon(sh, 'art_1')

  assert.equal(summary.kept, 2)
  assert.equal(summary.disabled, 2)
  // The cable cue is rewritten to the banked prompt, not merely renamed.
  assert.deepEqual(updates.find((u) => u.id === 'c1'), {
    id: 'c1',
    label: 'Cable pop and static crackle',
    prompt: 'sharp cable pop followed by a brief static crackle',
    isDisabled: false,
  })
  assert.deepEqual(updates.find((u) => u.id === 'c2'), { id: 'c2', isDisabled: true })
  // Right label, wrong prompt: still corrected, or it renders a new asset.
  assert.equal(updates.find((u) => u.id === 'c3').prompt, 'soft electronic buzzing of a neon sign')
  // Already off — no redundant write.
  assert.equal(updates.find((u) => u.id === 'c4'), undefined)
})

test('enforcement never asks the bank for an unlisted prompt', async () => {
  const asked = []
  const sh = {
    listSfxCues: async () => [
      { id: 'a', label: 'Mug clink', prompt: 'ceramic mug on a desk', isDisabled: false },
      { id: 'b', label: 'Pen plotter whir', prompt: 'a plotter drawing', isDisabled: false },
      { id: 'c', label: 'keyboard clatter', prompt: 'fast typing', isDisabled: false },
    ],
    updateSfxCue: async (_artifact, _id, fields) => { if (fields.prompt) asked.push(fields.prompt) },
  }
  await enforceSfxCanon(sh, 'art_1')
  for (const prompt of asked) {
    assert.ok(HNR_SFX_PROMPTS.includes(prompt), `off-whitelist prompt would render new audio: ${prompt}`)
  }
})
