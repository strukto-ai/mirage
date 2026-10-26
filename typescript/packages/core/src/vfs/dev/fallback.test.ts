import type * as AsyncContext from '../../utils/async_context.ts'
import { expect, it, vi } from 'vitest'
import { runWithSession } from '../../context/session_context.ts'
import { SessionState } from '../../workspace/session/session.ts'
import { DevicePipe } from '../../core/dev/pipe.ts'
import { DevFiles } from './store.ts'
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

it('refuses descriptor access when fallback contexts overlap', async () => {
  const files = new DevFiles()
  let readyResolve!: () => void
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve
  })
  let doneResolve!: () => void
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve
  })
  const pipe = new DevicePipe(true)
  const owner = runWithSession(new SessionState({ sessionId: 'owner' }), async () => {
    const [path, allocation] = files.allocateInput(pipe)
    readyResolve()
    await done
    expect(files.pipeOf(path.slice(4))).toBe(pipe)
    files.releaseInput(path, allocation)
  })
  await ready
  try {
    await runWithSession(new SessionState({ sessionId: 'peer' }), () => {
      expect(files.has('/fd/63')).toBe(false)
      expect(files.get('/fd/63')).toBeUndefined()
      expect([...files.keys()]).not.toContain('/fd/63')
      expect(() => files.set('/fd/63', new Uint8Array())).toThrow()
      expect(files.delete('/fd/63')).toBe(false)
      expect(() => files.allocateInput(new DevicePipe(true))).toThrow()
      return Promise.resolve()
    })
  } finally {
    doneResolve()
    await owner
  }
  expect(files.get('/fd/63')).toBeUndefined()
})

it('refuses moving a live pipe across mounts while browser sessions overlap', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  ws.createSession('peer')
  let peerIn!: () => void
  const entered = new Promise<void>((r) => {
    peerIn = r
  })
  let release!: () => void
  const held = new Promise<void>((r) => {
    release = r
  })
  const gate = (fn: () => Promise<void>): CLI =>
    new CLI({
      spec: new CommandSpec({ name: 'gate' }),
      handlers: {
        '': new CLIHandler({
          fn: async () => {
            await fn()
            return [null, new IOResult()]
          },
        }),
      },
    })
  ws.registerCli(
    'await-peer',
    gate(() => entered),
  )
  ws.registerCli(
    'hold',
    gate(async () => {
      peerIn()
      await held
    }),
  )
  const peer = ws.shell('hold', { sessionId: 'peer' })
  try {
    const io = await ws.shell(
      'f() { await-peer; mv "$1" /data/out 2>/dev/null; echo mv=$?; cat "$1"; }; f <(printf hello)',
    )
    expect([io.exitCode, io.stdoutText]).toEqual([0, 'mv=1\nhello'])
  } finally {
    release()
    await peer
    await ws.close()
  }
})
