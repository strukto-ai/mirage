import { expect, it, vi } from 'vitest'
import type * as asyncContextModule from '../utils/async_context.ts'
import { CLISpec } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'

vi.mock('../utils/async_context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof asyncContextModule>()
  return {
    ...real,
    asyncContextIsolatesTasks: false,
    createAsyncContext<T>() {
      return new real.FallbackStorage<T>()
    },
  }
})

function barrier(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  return {
    wait: new Promise<void>((resolve) => {
      open = resolve
    }),
    get open() {
      return open
    },
  }
}

it('keeps visibility, write grants, umask and dotglob with their caller across awaits', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const a = barrier(),
    b = barrier(),
    releaseA = barrier(),
    releaseB = barrier()
  ws.registerCli(
    'holda',
    new CLISpec({
      name: 'holda',
      fn: async () => {
        a.open()
        await releaseA.wait
        return [null, new IOResult()]
      },
    }),
  )
  ws.registerCli(
    'holdb',
    new CLISpec({
      name: 'holdb',
      fn: async () => {
        b.open()
        await releaseB.wait
        return [null, new IOResult()]
      },
    }),
  )
  ws.createSession('restricted', {
    profile: {
      paths: { hide: ['/data/.hidden'] },
      mounts: new Map([['/data', { mode: MountMode.READ }]]),
    },
  })
  const setup = await ws.shell('echo secret > /data/.hidden; echo public > /data/public')
  expect(setup.exitCode).toBe(0)
  let left: ReturnType<Workspace['shell']> | undefined,
    right: ReturnType<Workspace['shell']> | undefined
  try {
    left = ws.shell(
      'umask 002; shopt -s dotglob; holda; printf "%s\\n" /data/*; mkdir /data/left; stat -c %a /data/left',
    )
    await a.wait
    right = ws.shell('umask 077; holdb; printf "%s\\n" /data/*; mkdir /data/right', {
      sessionId: 'restricted',
    })
    await b.wait
    releaseA.open()
    const l = await left
    expect([l.exitCode, l.stdoutText, l.stderrText]).toEqual([
      0,
      '/data/.hidden\n/data/public\n775\n',
      '',
    ])
    releaseB.open()
    const r = await right
    expect(r.stdoutText).toBe('/data/left\n/data/public\n')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toContain('Read-only file system')
  } finally {
    releaseA.open()
    releaseB.open()
    await Promise.allSettled([left, right])
    await ws.close()
  }
})

function equal(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected)
}
it('records each workspace I/O while another recorder is active at the same mount path', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    const peer = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    const enteredA = barrier(),
      enteredB = barrier(),
      releaseA = barrier(),
      releaseB = barrier()
    ws.registerCli(
      'hold',
      new CLISpec({
        name: 'hold',
        fn: async () => {
          enteredA.open()
          await releaseA.wait
          return [null, new IOResult()]
        },
      }),
    )
    peer.registerCli(
      'hold',
      new CLISpec({
        name: 'hold',
        fn: async () => {
          enteredB.open()
          await releaseB.wait
          return [null, new IOResult()]
        },
      }),
    )
    let left: ReturnType<Workspace['shell']> | undefined,
      right: ReturnType<Workspace['shell']> | undefined
    try {
      left = ws.shell('hold; echo left > /data/same; cat /data/same')
      await enteredA.wait
      right = peer.shell('hold; echo right > /data/same; cat /data/same')
      await enteredB.wait
      releaseA.open()
      equal((await left).stdoutText, 'left\n')
      releaseB.open()
      equal((await right).stdoutText, 'right\n')
      const leftOps = (await ws.observer.events()).filter((e) => e.type === 'op')
      const rightOps = (await peer.observer.events()).filter((e) => e.type === 'op')
      equal(
        leftOps.map((e) => [e.op, e.path, e.bytes]),
        [
          ['write', '/data/same', 5],
          ['read', '/data/same', 5],
        ],
      )
      equal(
        rightOps.map((e) => [e.op, e.path, e.bytes]),
        [
          ['write', '/data/same', 6],
          ['read', '/data/same', 6],
        ],
      )
    } finally {
      releaseA.open()
      releaseB.open()
      await Promise.allSettled([left, right])
      await peer.close()
    }
  } finally {
    await ws.close()
  }
})
