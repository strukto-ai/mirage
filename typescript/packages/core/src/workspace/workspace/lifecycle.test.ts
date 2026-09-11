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
import { CapacityState, ResourceName } from '../../types.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { type JobRunner, JobStatus } from '../../shell/job_table/index.ts'
import type { ShellParser } from '../../shell/parse/index.ts'
import { MountMode } from '../../types.ts'
import { ExecutionNode } from '../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'
import { dropServiceCaches } from '../executor/command/run.ts'

let parser: ShellParser

beforeAll(async () => {
  parser = await getTestParser()
})

function buildWs(): Workspace {
  return new Workspace(
    { '/m': [new RAMResource(), MountMode.WRITE] },
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

describe('closeWorkspace', () => {
  // A bare abort leaves such a job RUNNING with no ending chunk, so
  // anyone parked on waitFinished waits forever on a workspace that is
  // already gone. killAll never joins the runner, so settling here
  // cannot block shutdown on a job that is mid-write.
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

    await ws.close()

    expect(job.status).toBe(JobStatus.KILLED)
    expect(job.exitCode).toBe(137)
    await job.console.waitFinished()

    // The runner unwinding afterwards must not reopen or relabel it.
    release.fire?.()
    await Promise.resolve()
    expect(job.status).toBe(JobStatus.KILLED)
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

    await ws.close()
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
      (surface === 'df' ? [false] : [false, true]).map((streaming) => ({
        alias,
        streaming,
        surface,
      })),
    ),
  ),
)(
  'unmount waits for admitted resource use ($surface, streaming=$streaming, alias=$alias)',
  async ({ surface, streaming, alias }) => {
    const resource = new RAMResource()
    let entered = (): void => undefined
    let resume = (): void => undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const release = new Promise<void>((resolve) => {
      resume = resolve
    })
    let closed = false
    async function* chunks(): AsyncGenerator<Uint8Array> {
      entered()
      await release
      expect(closed).toBe(false)
      yield new TextEncoder().encode('value')
    }
    const read = async (): Promise<Uint8Array | AsyncIterable<Uint8Array>> => {
      if (streaming) return chunks()
      entered()
      await release
      expect(closed).toBe(false)
      return new TextEncoder().encode('value')
    }
    const resources: Record<string, RAMResource> = { '/data': resource }
    if (alias === 'initial') resources['/alias'] = resource
    const ws = new Workspace(resources, { shellParser: parser })
    if (alias === 'dynamic') ws.addMount('/alias', resource)
    vi.spyOn(resource, 'statfs').mockImplementation(async () => {
      entered()
      await release
      expect(closed).toBe(false)
      return { state: CapacityState.UNKNOWN }
    })
    ws.ops.register({ name: 'read', resource: 'ram', filetype: null, write: false, fn: read })
    const [registered] = command({
      name: 'readvalue',
      resource: 'ram',
      spec: new CommandSpec({ rest: new Operand({ type: 'path' }) }),
      fn: async () => [await read(), new IOResult()],
    })
    if (registered === undefined) throw new Error('missing command')
    ws.mount('/data').register(registered)
    const closeResource = resource.close.bind(resource)
    vi.spyOn(resource, 'close').mockImplementation(async () => {
      closed = true
      await closeResource()
    })
    const running = (async () => {
      if (surface === 'df') {
        const result = await ws.execute('df /data')
        expect(result.exitCode).toBe(0)
        return 'value'
      }
      if (surface === 'command')
        return new TextDecoder().decode((await ws.execute('readvalue /data/file')).stdout)
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
      resume()
      expect(await running).toBe('value')
      await removing
      expect(closed).toBe(true)
    } finally {
      resume()
      await Promise.allSettled([running, ...(removing === undefined ? [] : [removing])])
      await ws.close()
    }
  },
)

it('workspace close waits for resource retirements before closing stores', async () => {
  const resource = new RAMResource()
  const ws = new Workspace({ '/data': resource }, { shellParser: parser })
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
  const closeResource = resource.close.bind(resource)
  vi.spyOn(resource, 'close').mockImplementation(async () => {
    entered()
    await release
    await closeResource()
    events.push('resource')
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
    expect(events).toEqual(['resource', 'store'])
  } finally {
    resume()
    await Promise.allSettled([removing, ...(closing === undefined ? [] : [closing])])
    await ws.close()
  }
})

it('unmount drains an admitted resource open before closing it', async () => {
  const resource = new RAMResource()
  const ws = new Workspace({ '/data': resource }, { shellParser: parser })
  let entered = (): void => undefined
  let resume = (): void => undefined
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const release = new Promise<void>((resolve) => {
    resume = resolve
  })
  let closed = false
  vi.spyOn(resource, 'open').mockImplementation(async () => {
    entered()
    await release
  })
  vi.spyOn(resource, 'close').mockImplementation(() => {
    closed = true
    return Promise.resolve()
  })
  const reading = ws.dispatch('read', '/data/file').catch((error: unknown) => error)
  let removing: Promise<void> | undefined
  try {
    await started
    removing = ws.unmount('/data')
    await vi.waitFor(() => {
      expect(ws.registry.tryMountForPrefix('/data')).toBeNull()
    })
    expect(closed).toBe(false)
    resume()
    await removing
    expect(closed).toBe(true)
    expect(await reading).toMatchObject({ code: 'EBUSY' })
  } finally {
    resume()
    await Promise.allSettled([reading, ...(removing === undefined ? [] : [removing])])
    await ws.close()
  }
})

it.each(['service', 'clear'])('unmount drains index invalidation (%s)', async (kind) => {
  const resource = new RAMResource()
  const ws = new Workspace({ '/data': resource })
  await ws.resolve('/data')
  let enter = (): void => undefined
  let resume = (): void => undefined
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const release = new Promise<void>((resolve) => {
    resume = resolve
  })
  const index = resource.index
  const method = kind === 'service' ? 'invalidate' : 'clear'
  const invalidate = index[method].bind(index)
  await index.put(
    '/outside-scope',
    new IndexEntry({ id: 'stale', name: 'stale', resourceType: 'ram' }),
  )
  vi.spyOn(index, method).mockImplementation(async () => {
    enter()
    await release
    expect(resource.isClosed).toBe(false)
    await invalidate()
  })
  const manager = ws.mount('/data').cacheManager
  if (manager === null) throw new Error('missing cache manager')
  const updating =
    kind === 'service'
      ? dropServiceCaches(ws.registry, [ResourceName.RAM])
      : manager.clearIndex(index)
  let removing: Promise<void> | undefined
  try {
    await entered
    let removed = false
    removing = ws.unmount('/data').then(() => {
      removed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(removed).toBe(false)
    expect(resource.isClosed).toBe(false)
    resume()
    await updating
    await removing
    expect(resource.isClosed).toBe(true)
    if (kind === 'clear') expect((await index.get('/outside-scope')).entry).toBeUndefined()
  } finally {
    resume()
    await Promise.allSettled([updating, ...(removing === undefined ? [] : [removing])])
    await ws.close()
  }
})
