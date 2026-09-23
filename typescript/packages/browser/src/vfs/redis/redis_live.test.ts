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
import { RedisVFS } from './redis.ts'

const DB_URL = process.env.UPSTASH_REDIS_URL
const skip = DB_URL === undefined || DB_URL === ''
const DEC = new TextDecoder()
const ENC = new TextEncoder()
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i)
const LIVE = 60_000

// Runs only against a real Upstash database, named by UPSTASH_REDIS_URL, the
// redis url the Upstash console prints. The fake in test-utils answers the
// same expectations, so a drift between the two shows up here first.
describe.skipIf(skip)('RedisVFS against a live Upstash database', () => {
  const prefix = `mirage:fs:test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`
  let vfs: RedisVFS
  let ws: Workspace

  beforeEach(async () => {
    vfs = new RedisVFS({ url: DB_URL ?? '', keyPrefix: prefix })
    await vfs.open()
    ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE })
  })

  afterEach(async () => {
    await vfs.store.clear()
    await ws.close()
  })

  it(
    'round-trips every byte value and sizes it in bytes',
    async () => {
      await vfs.writeFile(spec('/a.bin'), ALL_BYTES)
      expect(await vfs.readFile(spec('/a.bin'))).toEqual(ALL_BYTES)
      const r = await ws.shell('wc -c < /data/a.bin')
      expect(DEC.decode(r.stdout).trim()).toBe('256')
    },
    LIVE,
  )

  it(
    'keeps a key with slashes, spaces, plus, percent, question mark and hash intact',
    async () => {
      const path = '/dir with space/a+b%2F?#.txt'
      await vfs.store.setFile(path, ENC.encode('hello'))
      expect(await vfs.store.getFile(path)).toEqual(ENC.encode('hello'))
      expect(await vfs.store.listFiles()).toEqual([path])
    },
    LIVE,
  )

  it(
    'slices a range server-side',
    async () => {
      await vfs.store.setFile('/a.bin', ALL_BYTES)
      expect(await vfs.store.getFileRange('/a.bin', 10, 5)).toEqual(ALL_BYTES.slice(10, 15))
      expect(await vfs.store.getFileRange('/a.bin', 250, null)).toEqual(ALL_BYTES.slice(250))
      expect(await vfs.store.getFileRange('/a.bin', 0, 0)).toEqual(new Uint8Array(0))
      expect(await vfs.store.getFileRange('/a.bin', 10, 0)).toEqual(new Uint8Array(0))
      expect(await vfs.store.getFileRange('/missing', 0, 5)).toBeNull()
      expect(await vfs.store.getFileRange('/missing', 0, 0)).toBeNull()
    },
    LIVE,
  )

  it(
    'serves shell commands end to end',
    async () => {
      await ws.shell('mkdir -p /data/d/e')
      await ws.shell('echo hello | tee /data/d/e/x.txt > /dev/null')
      await ws.shell('echo world | tee /data/y.md > /dev/null')
      expect(DEC.decode((await ws.shell('cat /data/d/e/x.txt')).stdout)).toBe('hello\n')
      expect(
        DEC.decode((await ws.shell('ls /data')).stdout)
          .trim()
          .split('\n'),
      ).toEqual(['d', 'y.md'])
      expect(DEC.decode((await ws.shell("find /data -name '*.txt'")).stdout).trim()).toBe(
        '/data/d/e/x.txt',
      )
      await ws.shell('rm /data/y.md')
      expect((await ws.shell('cat /data/y.md')).exitCode).toBe(1)
    },
    LIVE,
  )

  it(
    'stores the stat overlay as side keys',
    async () => {
      await ws.shell('echo m | tee /data/m.txt > /dev/null')
      await ws.shell('chmod 600 /data/m.txt')
      expect(DEC.decode((await ws.shell('stat -c %a /data/m.txt')).stdout).trim()).toBe('600')
      expect(await vfs.store.getAttrs('/m.txt')).toEqual({ mode: '384' })
      expect(await vfs.store.getModified('/m.txt')).not.toBeNull()
    },
    LIVE,
  )

  it(
    'writes an empty file and a file larger than one request',
    async () => {
      await ws.shell('touch /data/empty')
      expect(DEC.decode((await ws.shell('wc -c < /data/empty')).stdout).trim()).toBe('0')
      const chunked = new RedisVFS({
        url: DB_URL ?? '',
        keyPrefix: prefix,
        maxRequestBytes: 64,
      })
      await chunked.writeFile(spec('/big.bin'), ALL_BYTES)
      expect(await vfs.readFile(spec('/big.bin'))).toEqual(ALL_BYTES)
    },
    LIVE,
  )
})
