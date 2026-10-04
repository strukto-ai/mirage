// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { IndexEntry } from '../../cache/index/config.ts'
import { command } from '../../commands/config.ts'
import { CommandSpec, Operand } from '../../commands/spec/types.ts'
import { IOResult } from '../../io/types.ts'
import { CapacityState } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { type JobRunner, JobStatus } from '../../shell/job_table/index.ts'
import {
  type Channel,
  type ConsoleChunk,
  JobConsole,
  RAMConsoleStore,
} from '../../shell/console/index.ts'
import type { ShellParser } from '../../shell/parse/index.ts'
import { MountMode } from '../../types.ts'
import { ExecutionNode } from '../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'
import { RAMNamespaceStore } from '../mount/namespace/ram.ts'
import { dropMountCaches } from '../executor/command/run.ts'
import { toStateDict } from '../snapshot/state.ts'
import { Mount } from '../mount/spec.ts'

it.each(
  [false, true].flatMap((used) =>
    [false, true].flatMap((wrapped) =>
      [false, true].map((unmount) => ({ used, wrapped, unmount })),
    ),
  ),
)(
  'restoring keeps borrowed drivers open ($used, $wrapped, $unmount)',
  async ({ used, wrapped, unmount }) => {
    const vfs = new RAMVFS()
    vfs.loadState({ type: 'ram', files: { '/file': new TextEncoder().encode('seed') } })
    const owner = new Workspace({ '/data': vfs }, { shellParser: parser })
    const override = wrapped ? new Mount(vfs, { index: { ttl: 37 } }) : vfs
    const replica = await Workspace.fromState(
      await toStateDict(owner),
      { shellParser: parser },
      { '/data': override },
    )
    try {
      if (used) expect((await replica.shell('cat /data/file')).stdoutText).toBe('seed')
      if (unmount) {
        await replica.unmount('/data')
        expect(vfs.isClosed).toBe(false)
      }
      await replica.close()
      expect(vfs.isClosed).toBe(false)
      expect((await owner.shell('cat /data/file')).stdoutText).toBe('seed')
      await owner.close()
      expect(vfs.isClosed).toBe(true)
    } finally {
      await replica.close()
      await owner.close()
    }
  },
)

let parser: ShellParser

beforeAll(async () => {
  parser = await getTestParser()
})

function buildWs(): Workspace {
  return new Workspace(
    { '/m': [new RAMVFS(), MountMode.WRITE] },
    { mode: MountMode.WRITE, shellParser: parser },
  )
}

/**
 * A runner that never observes the abort signal, like a long command
 * that does not check it. Only `release.fire()` ends it.
 *
 * Deliberately not `sleep`: it is the one command that consumes the
 * signal, so it settles through its own runner and would pass even when
 * teardown only aborts.
 */
function deaf(release: { fire?: () => void }): JobRunner {
  return async () => {
    await new Promise<void>((resolve) => {
      release.fire = resolve
    })
    return [new IOResult(), new ExecutionNode()]
  }
}

/**
 * A RAM console that records every write landing after close. A Redis
 * console reconnects for such a write, and nothing quits that client
 * again. `open()` lets the held-back writes through.
 */
class LateWriteStore extends RAMConsoleStore {
  readonly late: Channel[] = []
  private readonly gate: Promise<void>
  open: () => void = () => undefined

  constructor() {
    super()
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve
    })
  }

  override async append(channel: Channel, data: Uint8Array): Promise<ConsoleChunk> {
    await this.gate
    if (this.closed) this.late.push(channel)
    return super.append(channel, data)
  }
}

/** A runner that ends only through its abort, as `sleep` does. */
function untilAborted(abort: AbortController): JobRunner {
  return () =>
    new Promise((_resolve, reject) => {
      abort.signal.addEventListener(
        'abort',
        () => {
          reject(new DOMException('aborted', 'AbortError'))
        },
        { once: true },
      )
    })
}

describe('closeWorkspace', () => {
  // A disowned job killed by pid settles in its own task, writing its
  // ending as it unwinds; teardown must not close the console under
  // those writes.
  it('keeps a console open until its runner settles', async () => {
    const store = new LateWriteStore()
    const ws = new Workspace(
      { '/m': [new RAMVFS(), MountMode.WRITE] },
      { mode: MountMode.WRITE, shellParser: parser, consoleFactory: () => new JobConsole(store) },
    )
    const abort = new AbortController()
    const job = ws.jobTable.submit({
      command: 'sleep 30',
      run: untilAborted(abort),
      abort,
      cwd: '/',
    })
    ws.jobTable.disown(job.id)
    expect(job.process?.terminate()).toBe(true)
    await vi.waitFor(() => {
      expect(job.status).toBe(JobStatus.KILLED)
    })
    const closing = ws.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    store.open()
    await closing

    expect(store.late).toEqual([])
    expect(store.closed).toBe(true)
  })

  // A bare abort leaves such a job RUNNING with no ending chunk, so
  // anyone parked on waitFinished waits forever on a workspace that is
  // already gone. The console ends promptly, and teardown is still
  // joining the runner when the job has been recorded as killed.
  it('settles a job whose runner never observes the abort', async () => {
    const ws = buildWs()
    const release: { fire?: () => void } = {}
    const job = ws.jobTable.submit({
      command: 'long',
      run: deaf(release),
      abort: new AbortController(),
      cwd: '/',
    })
    expect(job.status).toBe(JobStatus.RUNNING)

    const closing = ws.close()
    await job.console.waitFinished()
    expect(job.process?.info.state).toBe('stopping')
    release.fire?.()
    await closing

    expect(job.status).toBe(JobStatus.KILLED)
    expect(job.exitCode).toBe(137)
    await job.console.waitFinished()

    // The runner unwinding afterwards must not reopen or relabel it.
    release.fire?.()
    await Promise.resolve()
    expect(job.status).toBe(JobStatus.KILLED)
  })

  // A JS promise cannot be cancelled, so such a runner gets the grace a
  // cancelled line gets (`joinOrAbort`) and is then left stopping: close
  // does not wait on it forever.
  it('returns while a runner that ignores its abort is still stopping', async () => {
    const ws = buildWs()
    const release: { fire?: () => void } = {}
    const job = ws.jobTable.submit({
      command: 'long',
      run: deaf(release),
      abort: new AbortController(),
      cwd: '/',
    })
    await ws.close()

    expect(job.status).toBe(JobStatus.KILLED)
    expect(job.process?.info.state).toBe('stopping')
    release.fire?.()
    await job.process?.join()
    expect(job.process?.info.state).toBe('exited')
  })

  it('is idempotent with a job running', async () => {
    const ws = buildWs()
    const release: { fire?: () => void } = {}
    const job = ws.jobTable.submit({
      command: 'long',
      run: deaf(release),
      abort: new AbortController(),
      cwd: '/',
    })

    const closing = ws.close()
    await job.console.waitFinished()
    release.fire?.()
    await closing
    await ws.close()

    expect(job.status).toBe(JobStatus.KILLED)
    release.fire?.()
  })
})

it.each([
  { secondary: false, failure: false },
  { secondary: false, failure: true },
  { secondary: true, failure: false },
  { secondary: true, failure: true },
])(
  'close settles profile persistence (secondary=$secondary, failure=$failure)',
  async ({ secondary, failure }) => {
    const ws = buildWs()
    await ws.ensureSessionsLoaded()
    ws.createSession('peer')
    await ws.flushSessions()
    const sessionId = secondary ? 'peer' : ws.defaultSessionId
    const store = ws.stateStore.sessions(ws.workspaceId)
    const events: string[] = []
    let enter = (): void => undefined
    let resume = (): void => undefined
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const release = new Promise<void>((resolve) => {
      resume = resolve
    })
    const casSet = store.casSet.bind(store)
    const closeStore = ws.stateStore.close.bind(ws.stateStore)
    vi.spyOn(store, 'casSet').mockImplementation(async (...args) => {
      enter()
      await release
      try {
        expect(events).not.toContain('store-closed')
        if (failure) throw new Error('store unavailable')
        return await casSet(...args)
      } finally {
        events.push('write-finished')
      }
    })
    vi.spyOn(ws.stateStore, 'close').mockImplementation(async () => {
      events.push('store-closed')
      await closeStore()
    })
    const updating = ws.setSessionProfile(sessionId, { paths: { hide: ['/data/secret'] } }).then(
      (value) => value,
      (error: unknown) => error,
    )
    let closing: Promise<void> | undefined
    let closed = false
    try {
      await entered
      closing = ws.close().then(() => {
        closed = true
      })
      await Promise.resolve()
      expect(closed).toBe(false)
      expect(events).toEqual([])
      await expect(ws.setSessionProfile(sessionId, {})).rejects.toThrow('Workspace is closed')
      const finished = await Promise.race([
        closing.then(() => true),
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            resolve(false)
          }, 30)
        }),
      ])
      expect(finished).toBe(false)
      resume()
      expect(await updating).toEqual(
        failure ? new Error('store unavailable') : ws.getSession(sessionId),
      )
      await closing
      expect(events).toEqual(['write-finished', 'store-closed'])
    } finally {
      resume()
      await updating
      await closing
      await ws.close()
    }
  },
)

it.each(
  [null, 'initial', 'dynamic'].flatMap((alias) =>
    ['op', 'command', 'df'].flatMap((surface) =>
      (surface === 'df' ? [false] : [false, true]).flatMap((streaming) =>
        [false, true].map((borrowed) => ({ alias, streaming, surface, borrowed })),
      ),
    ),
  ),
)(
  'unmount waits for admitted VFS use ($surface, streaming=$streaming, alias=$alias, borrowed=$borrowed)',
  async ({ surface, streaming, alias, borrowed }) => {
    const vfs = new RAMVFS()
    let entered = (): void => undefined
    let resume = (): void => undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const release = new Promise<void>((resolve) => {
      resume = resolve
    })
    let closed = false
    let indexClosed = false
    async function* chunks(): AsyncGenerator<Uint8Array> {
      entered()
      await release
      expect(closed).toBe(false)
      expect(indexClosed).toBe(false)
      yield new TextEncoder().encode('value')
    }
    const read = async (): Promise<Uint8Array | AsyncIterable<Uint8Array>> => {
      if (streaming) return chunks()
      entered()
      await release
      expect(closed).toBe(false)
      expect(indexClosed).toBe(false)
      return new TextEncoder().encode('value')
    }
    const mounts: Record<string, RAMVFS> = { '/data': vfs }
    if (alias === 'initial') mounts['/alias'] = vfs
    const owner = new Workspace(mounts, { shellParser: parser })
    const ws = borrowed
      ? await Workspace.fromState(await toStateDict(owner), { shellParser: parser }, mounts)
      : owner
    if (alias === 'dynamic') ws.addMount('/alias', vfs)
    vi.spyOn(vfs, 'capacity').mockImplementation(async () => {
      entered()
      await release
      expect(closed).toBe(false)
      expect(indexClosed).toBe(false)
      return { state: CapacityState.UNKNOWN }
    })
    ws.opsRegistry.register({ name: 'read', vfs: 'ram', filetype: null, write: false, fn: read })
    const [registered] = command({
      name: 'readvalue',
      vfs: 'ram',
      spec: new CommandSpec({ rest: new Operand({ type: 'path' }) }),
      fn: async () => [await read(), new IOResult()],
    })
    if (registered === undefined) throw new Error('missing command')
    ws.mount('/data').register(registered)
    const index = ws.mount('/data').indexStore
    const closeIndex = index.close.bind(index)
    vi.spyOn(index, 'close').mockImplementation(async () => {
      indexClosed = true
      await closeIndex()
    })
    const closeVfs = vfs.close.bind(vfs)
    vi.spyOn(vfs, 'close').mockImplementation(async () => {
      closed = true
      await closeVfs()
    })
    const running = (async () => {
      if (surface === 'df') {
        const result = await ws.shell('df /data')
        expect(result.exitCode).toBe(0)
        return 'value'
      }
      if (surface === 'command')
        return new TextDecoder().decode((await ws.shell('readvalue /data/file')).stdout)
      const value = (await ws.dispatch('read', '/data/file')) as
        | Uint8Array
        | AsyncIterable<Uint8Array>
      if (value instanceof Uint8Array) return new TextDecoder().decode(value)
      let result = ''
      for await (const chunk of value) result += new TextDecoder().decode(chunk)
      return result
    })()
    let removing: Promise<void> | undefined
    try {
      await started
      if (alias) {
        await ws.unmount('/data')
        expect(closed).toBe(false)
        expect(indexClosed).toBe(false)
      }
      let removed = false
      const prefix = alias ? '/alias' : '/data'
      removing = ws.unmount(prefix).then(() => {
        removed = true
      })
      await vi.waitFor(() => {
        expect(ws.registry.tryMountForPrefix(prefix)).toBeNull()
      })
      expect(removed).toBe(false)
      expect(closed).toBe(false)
      expect(indexClosed).toBe(false)
      resume()
      expect(await running).toBe('value')
      await removing
      expect(closed).toBe(!borrowed)
      expect(indexClosed).toBe(true)
    } finally {
      resume()
      await Promise.allSettled([running, ...(removing === undefined ? [] : [removing])])
      await ws.close()
      await owner.close()
    }
  },
)

it('workspace close waits for VFS retirements before closing stores', async () => {
  const vfs = new RAMVFS()
  const ws = new Workspace({ '/data': vfs }, { shellParser: parser })
  await ws.dispatch('stat', '/data')
  let entered = (): void => undefined
  let resume = (): void => undefined
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const release = new Promise<void>((resolve) => {
    resume = resolve
  })
  const events: string[] = []
  const closeVfs = vfs.close.bind(vfs)
  vi.spyOn(vfs, 'close').mockImplementation(async () => {
    entered()
    await release
    await closeVfs()
    events.push('vfs')
  })
  const closeStore = ws.stateStore.close.bind(ws.stateStore)
  vi.spyOn(ws.stateStore, 'close').mockImplementation(async () => {
    events.push('store')
    await closeStore()
  })
  const removing = ws.unmount('/data')
  let closing: Promise<void> | undefined
  try {
    await started
    let closed = false
    closing = ws.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(closed).toBe(false)
    expect(events).toEqual([])
    resume()
    await closing
    expect(events).toEqual(['vfs', 'store'])
  } finally {
    resume()
    await Promise.allSettled([removing, ...(closing === undefined ? [] : [closing])])
    await ws.close()
  }
})

it.each(['service', 'clear'])('unmount drains index invalidation (%s)', async (kind) => {
  const vfs = new RAMVFS()
  const ws = new Workspace({ '/data': vfs })
  await ws.resolve('/data')
  let enter = (): void => undefined
  let resume = (): void => undefined
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const release = new Promise<void>((resolve) => {
    resume = resolve
  })
  const index = ws.mount('/data').indexStore
  const method = kind === 'service' ? 'invalidate' : 'clear'
  const invalidate = index[method].bind(index)
  await index.put(
    '/outside-scope',
    new IndexEntry({ id: 'stale', name: 'stale', resourceType: 'ram' }),
  )
  vi.spyOn(index, method).mockImplementation(async () => {
    enter()
    await release
    expect(vfs.isClosed).toBe(false)
    await invalidate()
  })
  const manager = ws.mount('/data').cacheManager
  if (manager === null) throw new Error('missing cache manager')
  const updating = kind === 'service' ? dropMountCaches(ws.registry) : manager.clearIndex(index)
  let removing: Promise<void> | undefined
  try {
    await entered
    let removed = false
    removing = ws.unmount('/data').then(() => {
      removed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(removed).toBe(false)
    expect(vfs.isClosed).toBe(false)
    resume()
    await updating
    await removing
    expect(vfs.isClosed).toBe(true)
    if (kind === 'clear') expect((await index.get('/outside-scope')).entry).toBeUndefined()
  } finally {
    resume()
    await Promise.allSettled([updating, ...(removing === undefined ? [] : [removing])])
    await ws.close()
  }
})

describe('closeWorkspace surfaces closer failures', () => {
  function wsWithFailingClosers(failures: string[]): {
    ws: Workspace
    order: string[]
    ready: Promise<void>
  } {
    const vfs = new RAMVFS()
    const ws = new Workspace(
      { '/m': [vfs, MountMode.WRITE] },
      { mode: MountMode.WRITE, shellParser: parser },
    )
    const order: string[] = []
    const closeVfs = vfs.close.bind(vfs)
    vi.spyOn(vfs, 'close').mockImplementation(async () => {
      order.push('vfs')
      await closeVfs()
    })
    const ready = ws.dispatch('stat', '/m').then(() => {
      const closers = (ws as unknown as { closers: (() => Promise<void>)[] }).closers
      for (const message of failures) {
        closers.push(() => {
          order.push(message)
          return Promise.reject(new Error(message))
        })
      }
      closers.push(() => {
        order.push('later closer')
        return Promise.resolve()
      })
    })
    return { ws, order, ready }
  }

  it('raises a single closer failure once teardown has finished', async () => {
    const { ws, order, ready } = wsWithFailingClosers(['journal replay failed'])
    await ready
    await expect(ws.close()).rejects.toThrow('journal replay failed')
    // The point of the old catch: teardown still completes. The closers
    // after the failure ran, and the VFS still closed.
    expect(order).toEqual(['journal replay failed', 'later closer', 'vfs'])
  }, 30_000)

  it('leaves the workspace closed when a closer fails, so nothing resumes onto it', async () => {
    const vfs = new RAMVFS()
    const ws = new Workspace(
      { '/m': [vfs, MountMode.WRITE] },
      { mode: MountMode.WRITE, shellParser: parser },
    )
    await ws.dispatch('stat', '/m')
    const closers = (ws as unknown as { closers: (() => Promise<void>)[] }).closers
    closers.push(() => Promise.reject(new Error('journal replay failed')))
    await expect(ws.close()).rejects.toThrow('journal replay failed')
    // The mounts are already released here, and `closing` is memoized, so
    // the terminal flag has to be set or the guards that read only `closed`
    // would let a settled runner resolve and reopen one.
    expect((ws as unknown as { closed: boolean }).closed).toBe(true)
    await expect(ws.shell('echo hi')).rejects.toThrow('Workspace is closed')
    await expect(ws.dispatch('stat', '/m')).rejects.toThrow('Workspace is closed')
    // Teardown ran once and is not retried, so a second caller has to be told
    // why it failed rather than reading the memoized attempt as success.
    await expect(ws.close()).rejects.toThrow('journal replay failed')
  }, 30_000)

  it('keeps every teardown failure and still releases the later stages', async () => {
    const vfs = new RAMVFS()
    const ws = new Workspace(
      { '/m': [vfs, MountMode.WRITE] },
      { mode: MountMode.WRITE, shellParser: parser },
    )
    await ws.dispatch('stat', '/m')
    vi.spyOn(ws.processes, 'stop').mockImplementation(() => {
      throw new Error('process cancellation failed')
    })
    vi.spyOn(vfs, 'close').mockRejectedValue(new Error('VFS close failed'))
    vi.spyOn(ws.stateStore, 'close').mockRejectedValue(new Error('store close failed'))
    const closers = (ws as unknown as { closers: (() => Promise<void>)[] }).closers
    closers.push(() => Promise.reject(new Error('journal replay failed')))
    const err = await ws.close().then(
      () => null,
      (raised: unknown) => raised,
    )
    // The later rejection must not carry the replay failure back out of sight.
    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      'process cancellation failed',
      'journal replay failed',
      'VFS close failed',
      'store close failed',
    ])
    expect((ws as unknown as { closed: boolean }).closed).toBe(true)
    await expect(ws.close()).rejects.toBe(err)
  }, 30_000)

  it('aggregates when more than one closer fails', async () => {
    const { ws, order, ready } = wsWithFailingClosers(['first gone', 'second gone'])
    await ready
    const err = await ws.close().then(
      () => null,
      (raised: unknown) => raised,
    )
    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      'first gone',
      'second gone',
    ])
    expect(order).toContain('later closer')
    expect(order).toContain('vfs')
  }, 30_000)
})

describe('Workspace.delete', () => {
  it('clears a namespace store passed in directly', async () => {
    // A store handed in directly is where this workspace's links live, so
    // delete clears it too, not only the planes the state store owns.
    const namespaceStore = new RAMNamespaceStore()
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE, namespaceStore })
    await namespaceStore.set('/data/l', { mode: 0o600 })
    await ws.delete()
    expect((await namespaceStore.load()).size).toBe(0)
  })

  it('refuses after close rather than keep the state quietly', async () => {
    // close() closed the stores the state lives in, so a later delete has
    // nothing it can drop; it says so instead of answering success.
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.close()
    await expect(ws.delete()).rejects.toThrow('closed before delete')
  })
})

describe('cancel and kill', () => {
  async function linesRunning(ws: Workspace, count: number): Promise<void> {
    const lines = (ws as unknown as { lines: Map<unknown, unknown> }).lines
    for (let i = 0; i < 500; i += 1) {
      if (lines.size === count) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`expected ${String(count)} lines, saw ${String(lines.size)}`)
  }

  it('cancels only the lines of the named session', async () => {
    const ws = buildWs()
    ws.createSession('a')
    ws.createSession('b')
    const a = ws.shell('sleep 30', { sessionId: 'a' })
    const b = ws.shell('sleep 30', { sessionId: 'b' })
    let bDone = false
    void b.then(
      () => (bDone = true),
      () => (bDone = true),
    )
    try {
      await linesRunning(ws, 2)
      expect(await ws.cancel('a')).toBe(1)
      await expect(a).rejects.toMatchObject({ name: 'AbortError' })
      expect(bDone).toBe(false)
      expect(await ws.cancel()).toBe(1)
      await expect(b).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await ws.close()
    }
  })

  it('reaches a line queued behind another', async () => {
    const ws = buildWs()
    const running = ws.shell('sleep 30')
    const queued = ws.shell('echo late')
    try {
      await linesRunning(ws, 2)
      expect(await ws.cancel(ws.defaultSessionId)).toBe(2)
      await expect(running).rejects.toMatchObject({ name: 'AbortError' })
      await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await ws.close()
    }
  })

  it('kills background jobs and keeps the session', async () => {
    const ws = buildWs()
    ws.createSession('a')
    try {
      await ws.shell('sleep 30 &', { sessionId: 'a' })
      expect(await ws.kill('a')).toBe(1)
      expect(ws.jobTable.runningJobs('a')).toEqual([])
      expect((await ws.shell('echo alive', { sessionId: 'a' })).stdoutText).toBe('alive\n')
    } finally {
      await ws.close()
    }
  })

  it('cancels a running line when its session closes', async () => {
    const ws = buildWs()
    ws.createSession('a')
    const line = ws.shell('sleep 30', { sessionId: 'a' })
    try {
      await linesRunning(ws, 1)
      await ws.closeSession('a')
      await expect(line).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await ws.close()
    }
  })
})

describe('capture barrier', () => {
  async function linesRunning(ws: Workspace, count: number): Promise<void> {
    const lines = (ws as unknown as { lines: Map<unknown, unknown> }).lines
    for (let i = 0; i < 500; i += 1) {
      if (lines.size === count) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`expected ${String(count)} lines, saw ${String(lines.size)}`)
  }

  it('answers EBUSY while a line will not end', async () => {
    const ws = buildWs()
    const line = ws.shell('sleep 30')
    try {
      await linesRunning(ws, 1)
      await expect(ws.quiesced(() => Promise.resolve(1), 0.1)).rejects.toMatchObject({
        code: 'EBUSY',
      })
      expect(await ws.cancel()).toBe(1)
      await expect(line).rejects.toMatchObject({ name: 'AbortError' })
      expect(await ws.quiesced(() => Promise.resolve(1), 0.1)).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('runs a line started during a capture after it', async () => {
    const ws = buildWs()
    const order: string[] = []
    try {
      let line: Promise<unknown> = Promise.resolve()
      await ws.quiesced(async () => {
        line = ws.shell('echo after').then((r) => order.push(r.stdoutText))
        await new Promise((resolve) => setTimeout(resolve, 50))
        order.push('captured')
      })
      await line
      expect(order).toEqual(['captured', 'after\n'])
    } finally {
      await ws.close()
    }
  })
})
