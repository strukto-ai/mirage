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

import { FileChangeKind, PathSpec } from '../../../types.ts'
import { describe, expect, it } from 'vitest'
import { RedisAccessor } from '../../../accessor/redis.ts'
import type { RedisStoreLike } from '../../../resource/redis/store.ts'
import { RedisEventHook } from './hook.ts'

const ROOT = new PathSpec({ virtual: '/r', directory: '/r', resourcePath: '' })

function map(eventType: string, payload: unknown) {
  const store = { keyPrefix: 'wt:' } as unknown as RedisStoreLike
  const hook = new RedisEventHook(new RedisAccessor(store))
  return hook.toEvents(ROOT, eventType, payload as never)
}

describe('RedisEventHook', () => {
  it('maps a set to an update on the virtual path', async () => {
    const events = await map('set', 'wt:file:/day/a.txt')
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe(FileChangeKind.UPDATE)
    expect(events[0]?.path.virtual).toBe('/r/day/a.txt')
    expect(events[0]?.path.resourcePath).toBe('day/a.txt')
  })

  it('maps every deletion verb to DELETE', async () => {
    for (const verb of ['del', 'unlink', 'expired', 'evicted', 'rename_from']) {
      const events = await map(verb, 'wt:file:/day/a.txt')
      expect(events[0]?.kind).toBe(FileChangeKind.DELETE)
    }
  })

  it('maps rename_to to an update on the new key', async () => {
    const events = await map('rename_to', 'wt:file:/day/new.txt')
    expect(events[0]?.kind).toBe(FileChangeKind.UPDATE)
    expect(events[0]?.path.virtual).toBe('/r/day/new.txt')
  })

  it('maps side keys to nothing', async () => {
    expect(await map('set', 'wt:modified:/day/a.txt')).toEqual([])
    expect(await map('set', 'wt:attrs:/day/a.txt')).toEqual([])
  })

  it('re-inventories the mount on a dir-set change', async () => {
    const events = await map('sadd', 'wt:dir')
    expect(events[0]?.kind).toBe(FileChangeKind.UNKNOWN)
    expect(events[0]?.path.virtual).toBe('/r')
    expect((await map('srem', 'wt:dir'))[0]?.kind).toBe(FileChangeKind.UNKNOWN)
  })

  it('maps an unrelated verb on the dir set to nothing', async () => {
    expect(await map('smembers', 'wt:dir')).toEqual([])
  })

  it('maps a key from another namespace to nothing', async () => {
    expect(await map('set', 'other:file:/day/a.txt')).toEqual([])
  })

  it('maps an unhandled verb to nothing', async () => {
    expect(await map('expire', 'wt:file:/day/a.txt')).toEqual([])
  })

  it('maps a non-string payload to nothing', async () => {
    expect(await map('set', { key: 'wt:file:/a.txt' })).toEqual([])
  })
})
