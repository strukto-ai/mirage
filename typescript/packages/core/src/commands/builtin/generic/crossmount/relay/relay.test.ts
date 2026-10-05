import { expect, it, vi } from 'vitest'
import { Cmd } from '../types.ts'
import { runRelay } from './relay.ts'

it('rejects the wrong relay strategy before dispatch', async () => {
  const dispatch = vi.fn()
  const runSingle = vi.fn()
  await expect(runRelay(Cmd.CAT, [], [], {}, dispatch, runSingle)).rejects.toThrow(
    'Unsupported cross-mount relay command: cat',
  )
  expect(dispatch).not.toHaveBeenCalled()
  expect(runSingle).not.toHaveBeenCalled()
})
