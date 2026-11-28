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

import { MountMode, ReadPolicy } from '@struktoai/mirage-core/types'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type HubRepo, madeRepo } from '../../../../core/tests/fixtures/hub_repo.ts'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { ExpiredOnArrival } from '../../../tests/core/hf_hub/_test_util.ts'
import * as tree from '@struktoai/mirage-core/core/hf_hub/tree'
import { Workspace } from '../../workspace.ts'
import { buildVfs } from '../registry.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const OLD_LS = 'a.txt\nb.txt\n'

let origin = ''
let repos: HubRepo[] = []

beforeAll(async () => {
  origin = await serve('hf_hub')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(repos.map((repo) => repo.run.close()))
  repos = []
})

// A model repository of its own holding sub/a.txt, sub/b.txt and top.txt,
// its requests recorded from then on.
async function hub(): Promise<HubRepo> {
  const repo = await madeRepo(origin)
  repos.push(repo)
  await repo.commit({
    'sub/a.txt': ENC.encode('alpha\n'),
    'sub/b.txt': ENC.encode('bravo\n'),
    'top.txt': ENC.encode('top\n'),
  })
  await repo.run.recordRequests()
  return repo
}

function vfsOf(repo: HubRepo): Promise<BaseVFS> {
  return buildVfs('hf_models', repo.config())
}

function ws(vfs: BaseVFS, ttl = 600): Workspace {
  return new Workspace({
    '/m': new Mount(vfs, { mode: MountMode.READ, read: { policy: ReadPolicy.BOUNDED, ttl } }),
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function out(w: Workspace, line: string, sessionId?: string): Promise<string> {
  const result = await w.shell(line, sessionId === undefined ? {} : { sessionId })
  expect([result.exitCode, DEC.decode(result.stderr)], line).toEqual([0, ''])
  return DEC.decode(result.stdout)
}

function settleWithin<T>(work: Promise<T>, ms: number): Promise<'done' | 'pending'> {
  return Promise.race([
    work.then(() => 'done' as const),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => {
        resolve('pending')
      }, ms)
    }),
  ])
}

/** Pause the first tree walk until released; one-shot. */
function gateWalk(): { walking: Promise<void>; release: () => void } {
  const original = tree.fetchTree
  let armed = true
  let signal = (): void => undefined
  let release = (): void => undefined
  const walking = new Promise<void>((resolve) => {
    signal = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(tree, 'fetchTree').mockImplementation(async (...args) => {
    if (armed) {
      armed = false
      signal()
      await released
    }
    return original(...args)
  })
  return { walking, release }
}

describe('hf_hub listings under a shared view', () => {
  it('waits on a listing in progress instead of duplicating it', async () => {
    const repo = await hub()
    const w = ws(await vfsOf(repo))
    let first: Promise<string> | undefined
    let second: Promise<string> | undefined
    let gate: { walking: Promise<void>; release: () => void } | undefined
    try {
      w.createSession('s0')
      w.createSession('s1')
      expect(await out(w, 'ls /m/sub')).toBe(OLD_LS)
      const index = w.registry.mountFor('/m/sub').index
      await index.invalidate()
      gate = gateWalk()
      const before = await repo.count('tree')
      first = out(w, 'ls /m/sub', 's0')
      expect(await settleWithin(gate.walking, 2000)).toBe('done')
      second = out(w, 'ls /m/sub', 's1')
      const early = await settleWithin(second, 20)
      gate.release()
      expect(await Promise.all([first, second])).toEqual([OLD_LS, OLD_LS])
      expect((await repo.count('tree')) - before).toBe(1)
      expect(early).toBe('pending')
    } finally {
      gate?.release()
      await Promise.allSettled([first, second])
      await w.close()
    }
  })
})

describe('hf_hub refill answers its own caller', () => {
  it('lists a folder whose refill lands already expired', async () => {
    const repo = await hub()
    const vfs = await vfsOf(repo)
    const w = ws(vfs)
    Object.defineProperty(w.mount('/m'), 'indexStore', { value: new ExpiredOnArrival() })
    w.registry.attachFileCache(w.cache)
    try {
      expect(await out(w, 'ls /m/sub')).toBe(OLD_LS)
    } finally {
      await w.close()
    }
  })
})

describe('hf_hub listings respect the mount ttl', () => {
  it('a listing expires with the mount and the next ls sees a remote add', async () => {
    const repo = await hub()
    const w = ws(await vfsOf(repo), 1)
    try {
      expect(await out(w, 'ls /m/sub')).toBe(OLD_LS)
      await repo.commit({ 'sub/c.txt': ENC.encode('charlie\n') })
      expect(await out(w, 'ls /m/sub')).toBe(OLD_LS)
      await sleep(1100)
      expect(await out(w, 'ls /m/sub')).toBe('a.txt\nb.txt\nc.txt\n')
    } finally {
      await w.close()
    }
  })
})
