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

import { describe, expect, it, vi } from 'vitest'

import { PathSpec } from '../types.ts'
import {
  activeCacheManager,
  captureRead,
  publishRead,
  nativeCondition,
  runWithCacheManager,
  runWithWriteContext,
  settleAfter,
} from './context.ts'
import type { WriteContext } from './types.ts'

class FakeManager {
  probedStat(): null {
    return null
  }

  cachedSizes(paths: readonly PathSpec[]): Promise<(number | null)[]> {
    return Promise.resolve(paths.map(() => null))
  }

  isCached(_path: PathSpec): Promise<boolean> {
    return Promise.resolve(false)
  }
}

describe('cache context', () => {
  it('scopes the manager to the run', async () => {
    const manager = new FakeManager()
    await runWithCacheManager(manager, async () => {
      expect(activeCacheManager()).toBe(manager)
      await Promise.resolve()
    })
    expect(activeCacheManager()).toBeNull()
  })

  it('nested runs restore the outer manager', async () => {
    const outer = new FakeManager()
    const inner = new FakeManager()
    await runWithCacheManager(outer, async () => {
      await runWithCacheManager(inner, async () => {
        expect(activeCacheManager()).toBe(inner)
        await Promise.resolve()
      })
      expect(activeCacheManager()).toBe(outer)
    })
  })
})

class OpFailed extends Error {}
class SettleFailed extends Error {}

describe('settleAfter', () => {
  // The op's own error wins over a settle that fails after it; that settle
  // error is reported instead.
  it.each([
    [null, false, null, 'done'],
    [OpFailed, false, OpFailed, undefined],
    [OpFailed, true, OpFailed, undefined],
    [null, true, SettleFailed, 'done'],
  ] as const)('op error %o, settle breaks %s: raises %o', async (opError, breaks, raised, seen) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const results: (string | undefined)[] = []
    const run = settleAfter(
      () => (opError === null ? Promise.resolve('done') : Promise.reject(new opError())),
      (result) => {
        results.push(result)
        return breaks ? Promise.reject(new SettleFailed()) : Promise.resolve()
      },
    )
    if (raised === null) expect(await run).toBe('done')
    else await expect(run).rejects.toBeInstanceOf(raised)
    expect(results).toEqual([seen])
    expect(warn).toHaveBeenCalledTimes(opError !== null && breaks ? 1 : 0)
    warn.mockRestore()
  })
})

it.each([['verified'], [null], ['first', 'second']])(
  'capture keeps exact-object facts, including %j',
  async (...tokens) => {
    const data = new Uint8Array([1])
    const [result, facts] = await captureRead('/m/x', () => {
      publishRead('/m/other', data, 'wrong-path')
      publishRead('/m/x', new Uint8Array([1]), 'wrong-object')
      for (const token of tokens) publishRead('/m/x', data, token)
      return Promise.resolve(data)
    })
    expect(result).toBe(data)
    expect(facts).toEqual(tokens)
  },
)

it('capture preserves non-byte results', async () => {
  expect(await captureRead('/m/x', () => Promise.resolve(42))).toEqual([42, []])
})

describe('nativeCondition', () => {
  const path = new PathSpec({ virtual: '/box/f', directory: '/box/', vfsPath: '/f' })

  function context(kept: string[]): WriteContext {
    return {
      vfs: 'box',
      conditions: ['put', 'copy', 'delete'],
      readVersion: () => Promise.resolve('v1'),
      readVersions: (paths) => Promise.resolve(paths.map(() => 'v1')),
      drop: () => Promise.resolve(),
      keep: (_path, version) => {
        kept.push(version)
        return Promise.resolve()
      },
    }
  }

  it.each(['put', 'copy', 'delete'] as const)(
    'names the op it cannot condition: %s',
    async (kind) => {
      const call = runWithWriteContext('/box/', context([]), () =>
        nativeCondition(path, { ifMatch: 's1' }, { content: 's1', native: null }, kind),
      )
      await expect(call).rejects.toThrow(`conditional ${kind}`)
    },
  )
})
