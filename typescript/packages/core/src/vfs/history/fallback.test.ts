import type * as AsyncContext from '../../utils/async_context.ts'
import { expect, it, vi } from 'vitest'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../ram/ram.ts'
import { MountMode } from '../../types.ts'
import { CLI, CLIHandler } from '../../commands/cli/types.ts'
import { CommandSpec } from '../../commands/spec/types.ts'
import { IOResult } from '../../io/types.ts'

vi.mock('../../utils/async_context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AsyncContext>()
  return {
    ...actual,
    asyncContextIsolatesTasks: false,
    createAsyncContext: () => new actual.FallbackStorage(),
  }
})

it('a session reads its own history while another session is mid-line', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  ws.createSession('peer')
  let entered!: () => void
  const holding = new Promise<void>((r) => {
    entered = r
  })
  let release!: () => void
  const held = new Promise<void>((r) => {
    release = r
  })
  ws.registerCli(
    'hold',
    new CLI({
      spec: new CommandSpec({ name: 'hold' }),
      handlers: {
        '': new CLIHandler({
          fn: async () => {
            entered()
            await held
            return [null, new IOResult()]
          },
        }),
      },
    }),
  )
  await ws.shell('echo peer-secret', { sessionId: 'peer' })
  await ws.shell('echo mine')
  const peer = ws.shell('hold', { sessionId: 'peer' })
  await holding
  try {
    const io = await ws.shell('cat /.bash_history')
    expect(io.exitCode).toBe(0)
    expect(io.stdoutText).toContain('echo mine')
    expect(io.stdoutText).not.toContain('peer-secret')
    const size = await ws.shell('wc -c < /.bash_history')
    expect(Number(size.stdoutText.trim())).toBeGreaterThan(0)
  } finally {
    release()
    await peer
    await ws.close()
  }
})
