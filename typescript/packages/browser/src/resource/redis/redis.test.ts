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

import { MountMode } from '@struktoai/mirage-core/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as browserPkg from '../../index.ts'
import { createFakeUpstash, spec, type FakeUpstash } from '../../test-utils.ts'
import { Workspace } from '../../workspace.ts'
import { buildResource, knownResources } from '../registry.ts'
import { RedisResource } from './redis.ts'
import { UpstashRedisStore } from './store.ts'

const DEC = new TextDecoder()
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i)

describe('RedisResource over the Upstash REST api', () => {
  let fake: FakeUpstash
  let resource: RedisResource
  let ws: Workspace

  beforeEach(async () => {
    fake = createFakeUpstash()
    resource = new RedisResource({
      url: fake.url,
      token: fake.token,
      keyPrefix: 'mirage:fs:',
      fetchImpl: fake.fetch,
    })
    await resource.open()
    ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE })
  })

  afterEach(async () => {
    await ws.close()
  })

  it('is the redis kind, keyed by url and prefix', () => {
    expect(resource.kind).toBe('redis')
    expect(resource.storageId()).toBe(`redis:${fake.url}/mirage:fs:`)
    expect(resource.store).toBeInstanceOf(UpstashRedisStore)
  })

  it('tee writes through the api and cat reads it back', async () => {
    await ws.execute('echo "hello world" | tee /data/hello.txt')
    const result = await ws.execute('cat /data/hello.txt')
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('hello world\n')
    expect(fake.keys()).toContain('mirage:fs:file:/hello.txt')
  })

  it('mkdir and ls list a directory', async () => {
    await ws.execute('mkdir /data/sub')
    await ws.execute('echo a | tee /data/sub/a.txt')
    await ws.execute('echo b | tee /data/sub/b.txt')
    const r = await ws.execute('ls /data/sub/')
    expect(DEC.decode(r.stdout).trim().split('\n').sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('find walks the keyspace', async () => {
    await ws.execute('mkdir -p /data/d/e')
    await ws.execute('echo x | tee /data/d/e/x.txt')
    await ws.execute('echo y | tee /data/y.md')
    const r = await ws.execute("find /data -name '*.txt'")
    expect(DEC.decode(r.stdout).trim()).toBe('/data/d/e/x.txt')
  })

  it('stat sizes a file in bytes', async () => {
    await ws.execute('printf é | tee /data/u.txt > /dev/null')
    const r = await ws.execute('stat -c %s /data/u.txt')
    expect(DEC.decode(r.stdout).trim()).toBe('2')
  })

  it('rm removes the file key and its side keys', async () => {
    await ws.execute('echo gone | tee /data/gone.txt')
    await ws.execute('rm /data/gone.txt')
    expect(fake.keys().filter((k) => k.endsWith('/gone.txt'))).toEqual([])
    const r = await ws.execute('cat /data/gone.txt')
    expect(r.exitCode).toBe(1)
  })

  it('round-trips binary content', async () => {
    await resource.writeFile(spec('/a.bin'), ALL_BYTES)
    expect(await resource.readFile(spec('/a.bin'))).toEqual(ALL_BYTES)
    const r = await ws.execute('wc -c < /data/a.bin')
    expect(DEC.decode(r.stdout).trim()).toBe('256')
  })

  it('persists across resources sharing the url and prefix', async () => {
    await ws.execute('echo persisted | tee /data/p.txt')
    const second = new RedisResource({ url: fake.url, token: fake.token, fetchImpl: fake.fetch })
    const ws2 = new Workspace({ '/again': second }, { mode: MountMode.READ })
    try {
      const r = await ws2.execute('cat /again/p.txt')
      expect(DEC.decode(r.stdout)).toBe('persisted\n')
    } finally {
      await ws2.close()
    }
  })

  it('takes the redis url the node mount takes, with the password as the token', async () => {
    await ws.execute('echo shared | tee /data/shared.txt')
    const same = new RedisResource({
      url: `rediss://default:${fake.token}@${new URL(fake.url).host}:6379`,
      fetchImpl: fake.fetch,
    })
    const ws2 = new Workspace({ '/again': same }, { mode: MountMode.READ })
    try {
      const r = await ws2.execute('cat /again/shared.txt')
      expect(DEC.decode(r.stdout)).toBe('shared\n')
    } finally {
      await ws2.close()
    }
  })

  it('getState captures the keyspace and loadState restores it elsewhere', async () => {
    await ws.execute('mkdir /data/kept')
    await ws.execute('echo state | tee /data/kept/s.txt')
    await resource.store.setAttrs('/kept/s.txt', { mode: '384' })
    const state = await resource.getState()
    expect(state.config).toEqual({ url: '<REDACTED>', keyPrefix: 'mirage:fs:' })
    expect(state.dirs).toContain('/kept')
    expect(Object.keys(state.files)).toEqual(['/kept/s.txt'])
    expect(state.attrs).toEqual({ '/kept/s.txt': { mode: '384' } })
    expect(Object.keys(state.modified ?? {}).sort()).toEqual(['/kept', '/kept/s.txt'])

    const other = createFakeUpstash()
    const restored = new RedisResource({
      url: other.url,
      token: other.token,
      fetchImpl: other.fetch,
    })
    await restored.loadState(state)
    const ws2 = new Workspace({ '/r': restored }, { mode: MountMode.READ })
    try {
      const r = await ws2.execute('cat /r/kept/s.txt && stat -c %a /r/kept/s.txt')
      expect(DEC.decode(r.stdout)).toBe('state\n600\n')
    } finally {
      await ws2.close()
    }
  })

  it('is built by the registry from a snake_case config', async () => {
    const built = await buildResource('redis', {
      url: fake.url,
      token: fake.token,
      key_prefix: 'other:',
      fetch_impl: fake.fetch,
    })
    expect(built).toBeInstanceOf(RedisResource)
    expect((built as RedisResource).keyPrefix).toBe('other:')
    expect(knownResources()).toContain('redis')
  })

  it('is exported from the package barrel with its core pieces', () => {
    expect(browserPkg.RedisResource).toBe(RedisResource)
    expect(browserPkg.UpstashRedisStore).toBe(UpstashRedisStore)
    expect(typeof browserPkg.REDIS_PROMPT).toBe('string')
    expect(browserPkg.REDIS_OPS.length).toBeGreaterThan(0)
    expect(browserPkg.REDIS_COMMANDS.length).toBeGreaterThan(0)
    expect(typeof browserPkg.RedisAccessor).toBe('function')
  })
})
