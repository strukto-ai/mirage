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

import { SessionState } from '../workspace/session/session.ts'
import { record, runWithRecording, startOp } from '../observe/context.ts'
import { OpRecord } from '../observe/record.ts'
import { CacheManager } from './manager.ts'
import { RAMFileCacheStore } from './file/ram.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  activeCacheManager,
  captureRead,
  publishRead,
  runWithCacheManager,
  runWithWriteContext,
  writeCondition,
  writesConditioned,
} from './context.ts'
import {
  ANY_WRITE,
  type CacheInvalidator,
  type ConditionSupport,
  type ReplaceRequest,
} from './types.ts'
import { MountMode, PathSpec, WritePolicy } from '../types.ts'
import { RAMIndexCacheStore } from './index/ram.ts'
import { runInCommandScope } from './index/scope.ts'
import { callsAs, currentCaller, runWithCaller, withCaller } from '../context/session_context.ts'
import { MountEntry } from '../workspace/mount/mount.ts'
import { materialize } from '../io/types.ts'
import { BaseVFS } from '../vfs/base.ts'
import type * as asyncContextModule from '../utils/async_context.ts'

const captureState = vi.hoisted(() => ({ enabled: false, value: undefined as unknown }))

// The browser-runtime branch under node's test runner: the real
// FallbackStorage, no task isolation.
vi.mock('../utils/async_context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof asyncContextModule>()
  return {
    ...real,
    asyncContextIsolatesTasks: false,
    createAsyncContext<T>() {
      class TrackedStorage extends real.FallbackStorage<T> {
        override run<R>(store: T, fn: () => R | Promise<R>): R | Promise<R> {
          if (captureState.enabled) captureState.value = store
          return super.run(store, fn)
        }
      }
      return new TrackedStorage()
    },
  }
})

function gate(): [Promise<void>, () => void] {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return [held, release]
}

function fakeManager(): CacheInvalidator {
  return {
    probedStat: () => null,
    cachedSizes(paths: readonly PathSpec[]): Promise<(number | null)[]> {
      return Promise.resolve(paths.map(() => null))
    },
    isCached(): Promise<boolean> {
      return Promise.resolve(false)
    },
  }
}

describe('the active cache manager on the fallback storage', () => {
  it('the read side abstains while two managers disagree', async () => {
    // A warm hit from another mount's cache is another mount's bytes;
    // a miss just reads the backend. So reads fail toward the cold
    // read while the frames disagree, and answer again once one
    // manager is live — or while every frame agrees (a nested rebind).
    const managerA = fakeManager()
    const managerB = fakeManager()
    const [hold, release] = gate()
    let besideOther: CacheInvalidator | null = managerB
    let afterOtherSettled: CacheInvalidator | null = null
    const first = runWithCacheManager(managerB, async () => {
      await hold
    })
    const second = runWithCacheManager(managerA, async () => {
      besideOther = activeCacheManager()
      release()
      await first
      afterOtherSettled = activeCacheManager()
      await runWithCacheManager(managerA, () => {
        expect(activeCacheManager()).toBe(managerA)
        return Promise.resolve()
      })
    })
    await second
    expect(besideOther).toBeNull()
    expect(afterOtherSettled).toBe(managerA)
    expect(activeCacheManager()).toBeNull()
  })
})

it.each([false, true])(
  'overlapping same-path fills keep their own tokens, reverse=%s',
  async (reverse) => {
    const caches = [new RAMFileCacheStore(), new RAMFileCacheStore()] as const
    const managers = [
      new CacheManager(caches[0], null, '/s3/', true),
      new CacheManager(caches[1], null, '/s3/', true),
    ] as const
    const path = PathSpec.fromStrPath('/s3/a.txt', 'a.txt')
    const data = [new TextEncoder().encode('first'), new TextEncoder().encode('other')] as const
    const [heldA, releaseA] = gate()
    const [heldB, releaseB] = gate()
    const a = managers[0].fill(path, async () => {
      await heldA
      publishRead(path.virtual, data[0], 'first-token')
      return data[0]
    })
    const b = managers[1].fill(path, async () => {
      await heldB
      publishRead(path.virtual, data[1], 'other-token')
      return data[1]
    })
    // An unscoped backend read has no fill scope to detect as overlap.
    publishRead(path.virtual, new TextEncoder().encode('third'), 'foreign-token')
    if (reverse) {
      releaseB()
      await b
      releaseA()
    } else {
      releaseA()
      await a
      releaseB()
    }
    await Promise.all([a, b])
    expect(await caches[0].isFresh(path.virtual, 'first-token')).toBe(true)
    expect(await caches[1].isFresh(path.virtual, 'other-token')).toBe(true)
  },
)

it('a pending capture owns completed same-path bodies only weakly', async () => {
  const [held, release] = gate()
  captureState.enabled = true
  const pending = captureRead('/m/x', async () => {
    await held
    const data = new Uint8Array([42])
    publishRead('/m/x', data, 'held-token')
    return data
  })
  captureState.enabled = false
  try {
    for (const path of ['/m/x', '/m/other']) {
      for (let n = 0; n < 32; n++) {
        await captureRead(path, () => {
          const body = new Uint8Array(1024)
          publishRead(path, body, 'short-token')
          return Promise.resolve(body)
        })
      }
    }
    const state = (captureState.value as { readFacts: Record<string, unknown> }).readFacts
    expect(Object.keys(state).sort()).toEqual(['facts', 'path'])
    expect(state.path).toBe('/m/x')
    expect(state.facts).toBeInstanceOf(WeakMap)
  } finally {
    captureState.value = undefined
    release()
    expect((await pending)[1]).toEqual(['held-token'])
  }
})

describe('a conditional write on the fallback storage', () => {
  class S3Stub extends BaseVFS {
    override readonly name = 's3'
    override get conditionSupport() {
      return {
        put: ['absent', 'match'],
        copy: ['match'],
        delete: ['match'],
      } satisfies ConditionSupport
    }
    override readonly cachesReads = true
    override close(): Promise<void> {
      return Promise.resolve()
    }
  }

  async function conditional(vfs: BaseVFS = new S3Stub()): Promise<[MountEntry, PathSpec]> {
    const entry = new MountEntry({
      prefix: '/s3/',
      vfs,
      mode: MountMode.WRITE,
      write: WritePolicy.CONDITIONAL,
    })
    const cache = new RAMFileCacheStore()
    await cache.set('/s3/f', new TextEncoder().encode('one'), { fingerprint: 'v1' })
    entry.cacheManager = new CacheManager(cache, new RAMIndexCacheStore({ ttl: 600 }), '/s3/', true)
    const path = PathSpec.fromStrPath('/s3/f', '/f')
    return [entry, path]
  }

  it("agrees with itself across one mount's nested frames", async () => {
    // A command's frame and its dispatcher's are one mount, so the version stays.
    const [entry, path] = await conditional()
    const cond = await runWithWriteContext('/s3/', entry.writeContext(), () =>
      runWithWriteContext('/s3/', entry.writeContext(), () => writeCondition(path, 'put')),
    )
    expect(cond).toEqual({ kind: 'match', version: 'v1' })
  })

  it('settles explicit own evidence without an ambient frame', async () => {
    const [entry, path] = await conditional()
    const cond = await runWithWriteContext('/s3/', entry.writeContext(), () =>
      writeCondition(path, 'put', 'v2'),
    )
    expect(cond).toEqual({ kind: 'match', version: 'v2' })
  })

  it('sends a protected positional rewrite through the explicit commit hook', async () => {
    const commits: ReplaceRequest[] = []
    class ReplacingVFS extends S3Stub {
      override read(path: PathSpec): Promise<Uint8Array> {
        const data = new Uint8Array([1])
        publishRead(path.virtual, data, 'v1')
        return Promise.resolve(data)
      }
      override write(): Promise<unknown> {
        throw new Error('ordinary write received a protected replacement')
      }
      override async _replace(request: ReplaceRequest): Promise<unknown> {
        commits.push({ ...request, body: await materialize(request.body) })
        return null
      }
    }
    const [entry] = await conditional(new ReplacingVFS())
    await entry.call('pwrite', '/s3/f', [new Uint8Array([2]), 0])
    expect(commits).toHaveLength(1)
    expect(commits[0]?.condition).toEqual({ kind: 'match', version: 'v1' })
    expect(commits[0]?.body).toEqual(new Uint8Array([2]))
  })

  it('refuses a protected fallback when the backend has no explicit commit hook', async () => {
    class ReadableVFS extends S3Stub {
      override read(path: PathSpec): Promise<Uint8Array> {
        const data = new Uint8Array([1])
        publishRead(path.virtual, data, 'v1')
        return Promise.resolve(data)
      }
      override write(): Promise<unknown> {
        throw new Error('ordinary write received a protected replacement')
      }
    }
    const [entry] = await conditional(new ReadableVFS())
    await expect(entry.call('pwrite', '/s3/f', [new Uint8Array([2]), 0])).rejects.toMatchObject({
      code: 'ENOTSUP',
    })
  })

  it.each([
    { kind: 'any' },
    { kind: 'absent' },
    { kind: 'match', version: 'older' },
  ] satisfies ReplaceRequest['condition'][])(
    'keeps another same-mount writer independent of a paused $kind replacement',
    async (condition) => {
      const [entry, path] = await conditional()
      const context = entry.writeContext()
      const [otherStarted, startOther] = gate()
      const [replacementStarted, startReplacement] = gate()
      const [otherFinished, finishOther] = gate()
      class ReplacingVFS extends S3Stub {
        override async _replace(request: ReplaceRequest): Promise<unknown> {
          startReplacement()
          await otherFinished
          return request.condition
        }
      }
      const vfs = new ReplacingVFS()
      const first = runWithWriteContext('/s3/', context, async () => {
        await otherStarted
        return vfs._replace({ path, body: new Uint8Array(), condition })
      })
      const other = runWithWriteContext('/s3/', context, async () => {
        startOther()
        await replacementStarted
        try {
          return await writeCondition(path, 'put', 'new')
        } finally {
          finishOther()
        }
      })
      expect(await Promise.all([first, other])).toEqual([
        condition,
        { kind: 'match', version: 'new' },
      ])
    },
  )

  it.each([
    ['a sibling line nested in it', '/u/', true],
    ['a root line nested in it', '/', true],
    ['a root line around it', '/', false],
  ] as const)(
    'answers each path from the mount that owns it while lines overlap: %s',
    async (_name, plainPrefix, inner) => {
      // An unconditional mount's write is not refused for another mount's line.
      const [entry, path] = await conditional()
      const plain = PathSpec.fromStrPath('/u/g', '/g')
      const both = () => Promise.all([writeCondition(path, 'put'), writeCondition(plain, 'put')])
      const [cond, other] = await (inner
        ? runWithWriteContext('/s3/', entry.writeContext(), () =>
            runWithWriteContext(plainPrefix, null, both),
          )
        : runWithWriteContext(plainPrefix, null, () =>
            runWithWriteContext('/s3/', entry.writeContext(), both),
          ))
      expect([cond, other]).toEqual([{ kind: 'match', version: 'v1' }, ANY_WRITE])
    },
  )

  it('refuses a path no live frame owns while they disagree', async () => {
    const [entry] = await conditional()
    const stray = PathSpec.fromStrPath('/x/h', '/h')
    await expect(
      runWithWriteContext('/s3/', entry.writeContext(), () =>
        runWithWriteContext('/u/', null, () => writeCondition(stray, 'put')),
      ),
    ).rejects.toMatchObject({ code: 'ENOTSUP' })
  })

  it('answers whether a path writes conditioned while lines overlap, never throwing', async () => {
    // A read hands its token on when the owner is unclear: true is the safe side.
    const [entry, path] = await conditional()
    const paths = [path, PathSpec.fromStrPath('/u/g', '/g'), PathSpec.fromStrPath('/x/h', '/h')]
    const got = await runWithWriteContext('/s3/', entry.writeContext(), () =>
      runWithWriteContext('/u/', null, () => Promise.resolve(paths.map(writesConditioned))),
    )
    expect(got).toEqual([true, false, true])
  })

  it.each([
    ['a plain mount nested under it', '/s3/u/', [true, false]],
    ['a plain frame on its own prefix', '/s3/', [true, true]],
  ] as const)(
    'answers the longest owning prefix, true while its frames disagree: %s',
    async (_name, plainPrefix, want) => {
      const [entry, path] = await conditional()
      const paths = [path, PathSpec.fromStrPath('/s3/u/g', '/u/g')]
      const got = await runWithWriteContext('/s3/', entry.writeContext(), () =>
        runWithWriteContext(plainPrefix, null, () => Promise.resolve(paths.map(writesConditioned))),
      )
      expect(got).toEqual(want)
    },
  )
})

describe('listedThisCommand on the fallback storage', () => {
  // Without task isolation the latest live stamp may be another command's,
  // so a listing counts as the caller's own only while one command is live.
  it('counts no listing while another command is live', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    const [listed, markListed] = gate()
    const [checked, markChecked] = gate()
    let mine: boolean | null = null
    const a = runInCommandScope(async () => {
      await listed
      mine = manager.listedThisCommand('/data')
      markChecked()
    })
    const b = runInCommandScope(async () => {
      await manager.scopeIndex()?.setDir('/data', [])
      markListed()
      await checked
    })
    await Promise.all([a, b])
    expect(mine).toBe(false)
  })

  // A command's lazy output drains through a replay of its own scope, which
  // stacks a second frame with the same stamp.
  it.each([false, true])(
    'counts a listing the only live command fetched (replayed: %s)',
    async (replayed) => {
      const index = new RAMIndexCacheStore({ ttl: 600 })
      const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
      await runInCommandScope(async () => {
        await manager.scopeIndex()?.setDir('/data', [])
        const check = (): boolean => manager.listedThisCommand('/data')
        const mine = replayed
          ? await runWithCaller(currentCaller(), () => Promise.resolve(check()))
          : check()
        expect(mine).toBe(true)
      })
    },
  )
})

it("overlapping browser sessions cannot borrow or replace each other's versions", async () => {
  const manager = new CacheManager(
    null,
    null,
    '/s3/',
    true,
    () => true,
    600,
    undefined,
    undefined,
    () => [],
    true,
  )
  const a = new SessionState({ sessionId: 'a' })
  const b = new SessionState({ sessionId: 'b' })
  a.versions.keep(manager.versionScope, '/f', 'v1')
  b.versions.keep(manager.versionScope, '/f', 'v2')
  const path = PathSpec.fromStrPath('/s3/f', '/f')
  const rec = new OpRecord({
    op: 'read',
    path: '/s3/f',
    source: 's3',
    bytes: 1,
    timestamp: 0,
    durationMs: 0,
    fingerprint: 'v3',
  })
  await runWithCaller({ ...currentCaller(), session: a }, () =>
    runWithCaller({ ...currentCaller(), session: b }, async () => {
      await expect(manager.readVersion(path)).rejects.toMatchObject({ code: 'ENOTSUP' })
      expect(() => {
        manager.observe(rec)
      }).toThrow()
      expect(() => {
        manager.lose(path, 'v3')
      }).toThrow()
      await expect(manager.keepVersion(path, 'v3')).rejects.toMatchObject({ code: 'ENOTSUP' })
    }),
  )
  await expect(
    runWithCaller({ ...currentCaller(), session: a }, () =>
      runWithCaller({ ...currentCaller(), session: null }, () =>
        runWithWriteContext(
          '/s3/',
          {
            vfs: 's3',
            conditions: ['put'],
            readVersion: (p) => manager.readVersion(p),
            readVersions: (paths) => manager.readVersions(paths),
            drop: () => Promise.resolve(),
            keep: (p, version) => manager.keepVersion(p, version),
          },
          () => {
            throw new Error('overlap must be refused before the backend runs')
          },
        ),
      ),
    ),
  ).rejects.toMatchObject({ code: 'ENOTSUP' })
  expect(a.versions.read(manager.versionScope, '/f')).toBe('v1')
  expect(b.versions.read(manager.versionScope, '/f')).toBe('v2')
  await runWithCaller({ ...currentCaller(), session: a }, () =>
    runWithCaller({ ...currentCaller(), session: a.fork() }, async () => {
      expect(await manager.readVersion(path)).toBe('v1')
    }),
  )
})

it.each([false, true])(
  'rejects a new browser session before it can disrupt an in-flight conditional write (callback: %s)',
  async (callback) => {
    const manager = new CacheManager(
      null,
      null,
      '/s3/',
      true,
      () => true,
      600,
      undefined,
      undefined,
      () => [],
      true,
    )
    const a = new SessionState({ sessionId: 'a' })
    const b = new SessionState({ sessionId: 'b' })
    const base = currentCaller()
    const path = PathSpec.fromStrPath('/s3/f', '/f')
    a.versions.keep(manager.versionScope, '/f', 'v1')
    const [held, release] = gate()
    const [started, markStarted] = gate()
    let sent = false
    const upload = runWithCaller({ ...base, session: a }, () =>
      runWithWriteContext(
        '/s3/',
        {
          vfs: 's3',
          conditions: ['put'],
          readVersion: (p) => manager.readVersion(p),
          readVersions: (paths) => manager.readVersions(paths),
          drop: () => Promise.resolve(),
          keep: (p, version) => manager.keepVersion(p, version),
          observe: (rec) => {
            manager.observe(rec)
          },
        },
        () =>
          runWithRecording(async () => {
            expect(await writeCondition(path, 'put')).toEqual({ kind: 'match', version: 'v1' })
            const timer = startOp()
            markStarted()
            await held
            sent = true
            record('write', path.virtual, 's3', 1, timer, { fingerprint: 'v2' })
          }),
      ),
    )
    await started
    let entered = false
    try {
      const overlapping = async (): Promise<void> => {
        entered = true
        release()
        await upload
      }
      const caller = { ...base, session: b }
      await expect(
        (async () => {
          if (callback) await callsAs(caller, overlapping)()
          else await runWithCaller(caller, overlapping)
        })(),
      ).rejects.toMatchObject({ code: 'ENOTSUP' })
    } finally {
      release()
      await upload
    }
    expect(entered).toBe(false)
    expect(sent).toBe(true)
    expect(a.versions.read(manager.versionScope, '/f')).toBe('v2')
    expect(b.versions.read(manager.versionScope, '/f')).toBeNull()
  },
)

it.each([
  ['return', false],
  ['return', true],
  ['next', false],
  ['next', true],
] as const)(
  'closes a paused peer stream after %s during conditional work (failed: %s)',
  async (action, failed) => {
    const manager = new CacheManager(
      null,
      null,
      '/s3/',
      true,
      () => true,
      600,
      undefined,
      undefined,
      () => [],
      true,
    )
    const a = new SessionState({ sessionId: 'a' })
    const b = new SessionState({ sessionId: 'b' })
    const base = currentCaller()
    const context = {
      vfs: 's3',
      conditions: ['put'] as const,
      readVersion: (p: PathSpec) => manager.readVersion(p),
      readVersions: (paths: readonly PathSpec[]) => manager.readVersions(paths),
      drop: () => Promise.resolve(),
      keep: (p: PathSpec, version: string) => manager.keepVersion(p, version),
      observe: (rec: OpRecord) => {
        manager.observe(rec)
      },
    }
    const [closed, markClosed] = gate()
    let closeCount = 0
    let cancelled = 0
    const body = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1)
      },
      cancel() {
        cancelled++
      },
    })
    async function* source(): AsyncGenerator<number> {
      const reader = body.getReader()
      try {
        const chunk = await reader.read()
        if (!chunk.done) yield chunk.value
      } finally {
        await reader.cancel()
        reader.releaseLock()
        expect(currentCaller().session).toBe(b)
        closeCount++
        markClosed()
      }
    }
    const stream = withCaller(source(), { ...base, session: b, write: { prefix: '/s3/', context } })
    expect(await stream.next()).toEqual({ done: false, value: 1 })
    const upload = runWithCaller({ ...base, session: a }, () =>
      runWithWriteContext('/s3/', context, () =>
        runWithRecording(async () => {
          if (action === 'next')
            await expect(stream.next()).rejects.toMatchObject({ code: 'ENOTSUP' })
          else await stream.return(undefined)
          expect(closeCount).toBe(0)
          expect(currentCaller().session).toBe(a)
          if (failed) throw new Error('upload failed')
          record('write', '/s3/f', 's3', 1, startOp(), { fingerprint: 'v2' })
        }),
      ),
    )
    if (failed) await expect(upload).rejects.toThrow('upload failed')
    else await upload
    await closed
    await stream.return(undefined)
    expect(closeCount).toBe(1)
    expect(cancelled).toBe(1)
    expect(body.locked).toBe(false)
    expect(a.versions.read(manager.versionScope, '/f')).toBe(failed ? null : 'v2')
    expect(b.versions.read(manager.versionScope, '/f')).toBeNull()
  },
)
