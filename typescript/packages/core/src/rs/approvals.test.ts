import { describe, expect, it } from 'vitest'
import { Outcome, Scope, type Decision, type HandOff } from '../policy/types.ts'
import { ApprovalSnapshot } from './approvals.ts'

function decision(): Decision {
  return {
    id: 'shared-id',
    sessionId: 's',
    command: 'cat',
    argv: ['x'],
    cwd: '/',
    paths: [],
    reason: 'read',
    rule: { reason: 'read', commands: ['cat x'] },
    outcome: Outcome.ALLOW,
    scope: Scope.ONCE,
    note: '',
  }
}

describe('approval facts', () => {
  it('keeps long-script claim identities without repeating the source', () => {
    const source = 'cat x; '.repeat(1024)
    const handed: HandOff = { parent: null, origin: null, claimed: [] }
    for (let index = 0; index < 32; index++) {
      handed.claimed.push({
        occurrence: { parent: null, source, start: index, end: index + 1 },
        decision: { ...decision(), id: String(index) },
      })
    }
    const snapshot = new ApprovalSnapshot([], [handed], [handed])
    const claims = snapshot.split(handed, { parent: null, source, start: 0, end: source.length })
    expect(claims).toHaveLength(handed.claimed.length)
    claims.forEach((claim, index) => {
      expect(claim).toBe(handed.claimed[index])
    })
    expect(JSON.stringify(snapshot.wire).length).toBeLessThan(
      8 * source.length + 500 * claims.length,
    )
  })

  it('keeps equal-record identities and duplicate requested positions', () => {
    const first = decision()
    const second = { ...first }
    const handed: HandOff = {
      parent: null,
      origin: null,
      claimed: [
        { occurrence: { parent: null, source: 'cat x', start: 0, end: 5 }, decision: first },
      ],
    }
    const snapshot = new ApprovalSnapshot([first, second, first], [handed])
    const plan = snapshot.plan([0, 0, 0], [0, 0], ['cat', 'x'], '/', null)
    expect(plan.answers).toEqual([second, second])
    expect(plan.once).toEqual([second, second])
    plan.answers.forEach((record) => {
      expect(record).toBe(second)
    })
  })
})
