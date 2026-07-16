import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBrief } from '../worker/brief.mjs'

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
