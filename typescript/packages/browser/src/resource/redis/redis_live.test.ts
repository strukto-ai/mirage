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
import { spec } from '../../test-utils.ts'
import { Workspace } from '../../workspace.ts'
import { RedisResource } from './redis.ts'

const DB_URL = process.env.UPSTASH_REDIS_URL
const skip = DB_URL === undefined || DB_URL === ''
const DEC = new TextDecoder()
const ENC = new TextEncoder()
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i)
const LIVE = 60_000

// Runs only against a real Upstash database, named by UPSTASH_REDIS_URL, the
// redis url the Upstash console prints. The fake in test-utils answers the
// same expectations, so a drift between the two shows up here first.
describe.skipIf(skip)('RedisResource against a live Upstash database', () => {
  const prefix = `mirage:fs:test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`
  let resource: RedisResource
  let ws: Workspace

  beforeEach(async () => {
    resource = new RedisResource({ url: DB_URL ?? '', keyPrefix: prefix })
    await resource.open()
    ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE })
  })

  afterEach(async () => {
    await resource.store.clear()
    await ws.close()
  })

  it(
    'round-trips every byte value and sizes it in bytes',
    async () => {
      await resource.writeFile(spec('/a.bin'), ALL_BYTES)
      expect(await resource.readFile(spec('/a.bin'))).toEqual(ALL_BYTES)
      const r = await ws.execute('wc -c < /data/a.bin')
      expect(DEC.decode(r.stdout).trim()).toBe('256')
    },
    LIVE,
  )

  it(
    'keeps a key with slashes, spaces, plus, percent, question mark and hash intact',
    async () => {
      const path = '/dir with space/a+b%2F?#.txt'
      await resource.store.setFile(path, ENC.encode('hello'))
      expect(await resource.store.getFile(path)).toEqual(ENC.encode('hello'))
      expect(await resource.store.listFiles()).toEqual([path])
    },
    LIVE,
  )

  it(
    'slices a range server-side',
    async () => {
      await resource.store.setFile('/a.bin', ALL_BYTES)
      expect(await resource.store.getFileRange('/a.bin', 10, 5)).toEqual(ALL_BYTES.slice(10, 15))
      expect(await resource.store.getFileRange('/a.bin', 250, null)).toEqual(ALL_BYTES.slice(250))
      expect(await resource.store.getFileRange('/a.bin', 0, 0)).toEqual(new Uint8Array(0))
      expect(await resource.store.getFileRange('/a.bin', 10, 0)).toEqual(new Uint8Array(0))
      expect(await resource.store.getFileRange('/missing', 0, 5)).toBeNull()
      expect(await resource.store.getFileRange('/missing', 0, 0)).toBeNull()
    },
    LIVE,
  )

  it(
    'serves shell commands end to end',
    async () => {
      await ws.execute('mkdir -p /data/d/e')
      await ws.execute('echo hello | tee /data/d/e/x.txt > /dev/null')
      await ws.execute('echo world | tee /data/y.md > /dev/null')
      expect(DEC.decode((await ws.execute('cat /data/d/e/x.txt')).stdout)).toBe('hello\n')
      expect(
        DEC.decode((await ws.execute('ls /data')).stdout)
          .trim()
          .split('\n'),
      ).toEqual(['d', 'y.md'])
      expect(DEC.decode((await ws.execute("find /data -name '*.txt'")).stdout).trim()).toBe(
        '/data/d/e/x.txt',
      )
      await ws.execute('rm /data/y.md')
      expect((await ws.execute('cat /data/y.md')).exitCode).toBe(1)
    },
    LIVE,
  )

  it(
    'stores the stat overlay as side keys',
    async () => {
      await ws.execute('echo m | tee /data/m.txt > /dev/null')
      await ws.execute('chmod 600 /data/m.txt')
      expect(DEC.decode((await ws.execute('stat -c %a /data/m.txt')).stdout).trim()).toBe('600')
      expect(await resource.store.getAttrs('/m.txt')).toEqual({ mode: '384' })
      expect(await resource.store.getModified('/m.txt')).not.toBeNull()
    },
    LIVE,
  )

  it(
    'writes an empty file and a file larger than one request',
    async () => {
      await ws.execute('touch /data/empty')
      expect(DEC.decode((await ws.execute('wc -c < /data/empty')).stdout).trim()).toBe('0')
      const chunked = new RedisResource({
        url: DB_URL ?? '',
        keyPrefix: prefix,
        maxRequestBytes: 64,
      })
      await chunked.writeFile(spec('/big.bin'), ALL_BYTES)
      expect(await resource.readFile(spec('/big.bin'))).toEqual(ALL_BYTES)
    },
    LIVE,
  )
})
