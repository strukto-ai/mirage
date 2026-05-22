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

import { MountMode } from '@struktoai/mirage-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { RedisResource } from './redis.ts'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined
const DEC = new TextDecoder()

describe.skipIf(skip)('RedisResource as mount', () => {
  let ws: Workspace
  let resource: RedisResource
  const prefix = `mirage:fs:mount-test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`

  beforeEach(async () => {
    resource = new RedisResource(
      REDIS_URL !== undefined ? { url: REDIS_URL, keyPrefix: prefix } : { keyPrefix: prefix },
    )
    await resource.open()
    await resource.store.clear()
    await resource.store.addDir('/')
    ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE })
  })

  afterEach(async () => {
    await resource.store.clear()
    await ws.close()
  })

  it('tee writes to Redis then cat reads it back', async () => {
    await ws.execute('echo "hello world" | tee /data/hello.txt')
    const result = await ws.execute('cat /data/hello.txt')
    expect(DEC.decode(result.stdout)).toBe('hello world\n')
  })

  it('mkdir + ls show directory listing', async () => {
    await ws.execute('mkdir /data/sub')
    await ws.execute('echo "a" | tee /data/sub/a.txt')
    await ws.execute('echo "b" | tee /data/sub/b.txt')
    const r = await ws.execute('ls /data/sub/')
    expect(DEC.decode(r.stdout).trim().split('\n').sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('persists across workspaces sharing keyPrefix', async () => {
    await ws.execute('echo "persisted" | tee /data/p.txt')
    await ws.close()
    const resource2 = new RedisResource(
      REDIS_URL !== undefined ? { url: REDIS_URL, keyPrefix: prefix } : { keyPrefix: prefix },
    )
    const ws2 = new Workspace({ '/data': resource2 }, { mode: MountMode.WRITE })
    try {
      const r = await ws2.execute('cat /data/p.txt')
      expect(DEC.decode(r.stdout)).toBe('persisted\n')
    } finally {
      await ws2.close()
    }
  })

  it('rm removes a file', async () => {
    await ws.execute('echo "x" | tee /data/x.txt')
    await ws.execute('rm /data/x.txt')
    const ls = await ws.execute('ls /data/')
    expect(DEC.decode(ls.stdout)).not.toContain('x.txt')
  })

  it('glob expansion works via redis readdir', async () => {
    await ws.execute('echo "A" | tee /data/a.txt')
    await ws.execute('echo "B" | tee /data/b.txt')
    await ws.execute('echo "C" | tee /data/c.md')
    const r = await ws.execute('cat /data/*.txt')
    const out = DEC.decode(r.stdout)
    expect(out).toContain('A')
    expect(out).toContain('B')
    expect(out).not.toContain('C')
  })

  it('stat returns metadata for files and dirs', async () => {
    await ws.execute('echo "hi" | tee /data/f.txt')
    const rf = await ws.execute('stat /data/f.txt')
    expect(DEC.decode(rf.stdout)).toContain('size=3')
    await ws.execute('mkdir /data/d')
    const rd = await ws.execute('stat /data/d')
    expect(DEC.decode(rd.stdout)).toContain('directory')
  })

  it('getState / loadState round-trip', async () => {
    await ws.execute('echo "one" | tee /data/one.txt')
    await ws.execute('mkdir /data/sub')
    await ws.execute('echo "nested" | tee /data/sub/nested.txt')
    const state = await resource.getState()
    expect(Object.keys(state.files).sort()).toEqual(['/one.txt', '/sub/nested.txt'])
    expect(state.dirs).toContain('/sub')
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')
    expect(state.config).toEqual({ url: '<REDACTED>', keyPrefix: resource.keyPrefix })

    await resource.store.clear()
    await resource.store.addDir('/')
    await resource.loadState(state)
    const r = await ws.execute('cat /data/one.txt')
    expect(DEC.decode(r.stdout)).toBe('one\n')
  })
})
