import { describe, expect, it } from 'vitest'
import { closeAll, type Computations, execute } from './computations.ts'

describe('computations', () => {
  it('makes one diff dispatcher per worker and releases its stream on close', async () => {
    const a: Computations = new Map()
    const b: Computations = new Map()
    await execute({ name: 'diffDispatch', args: [{ kind: 'close' }] }, a)
    await execute({ name: 'diffDispatch', args: [{ kind: 'close' }] }, b)
    const [left, right] = await Promise.all([a.get('diffDispatch'), b.get('diffDispatch')])
    expect(left).toBeDefined()
    expect(left).not.toBe(right)
    let closed = 0
    a.set('probe', Promise.resolve(Object.assign(() => null, { close: () => void closed++ })))
    await closeAll(a)
    expect(closed).toBe(1)
    expect(a.size).toBe(0)
  })

  it('answers an unknown computation as a failed reply', async () => {
    const reply = await execute({ name: 'nope', args: [] }, new Map())
    expect(reply.ok).toBe(false)
  })
})
