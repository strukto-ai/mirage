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

import type { CommandOpts } from '@struktoai/mirage-core/commands/config'
import { Precision } from '@struktoai/mirage-core/provision/types'
import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RedisAccessor } from '@struktoai/mirage-core/accessor/redis'
import { writeBytes } from '@struktoai/mirage-core/core/redis/write'
import { RedisStore } from '../../../resource/redis/store.ts'
import {
  fileReadProvision,
  headTailProvision,
  metadataProvision,
} from '@struktoai/mirage-core/commands/builtin/redis/_provision'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined
const ENC = new TextEncoder()

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe.skipIf(skip)('redis provision helpers', () => {
  let store: RedisStore
  let acc: RedisAccessor
  const prefix = `mirage:fs:provision-test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`

  function makeOpts(flags: Record<string, string | boolean> = {}): CommandOpts {
    return {
      stdin: null,
      flags,
      filetypeFns: null,
      cwd: '/',
    }
  }

  beforeEach(async () => {
    store = new RedisStore(
      REDIS_URL !== undefined ? { url: REDIS_URL, keyPrefix: prefix } : { keyPrefix: prefix },
    )
    acc = new RedisAccessor(store)
    await store.clear()
    await store.addDir('/')
  })

  afterEach(async () => {
    await store.clear()
    await store.close()
  })

  it('fileReadProvision sums sizes as EXACT', async () => {
    await writeBytes(acc, spec('/a'), ENC.encode('hello'))
    await writeBytes(acc, spec('/b'), ENC.encode('world!'))
    const r = await fileReadProvision(acc, [spec('/a'), spec('/b')], [], makeOpts())
    expect(r.precision).toBe(Precision.EXACT)
    expect(r.networkReadLow).toBe(11)
    expect(r.networkReadHigh).toBe(11)
    expect(r.readOps).toBe(2)
  })

  it('fileReadProvision returns UNKNOWN when paths empty', async () => {
    const r = await fileReadProvision(acc, [], [], makeOpts())
    expect(r.precision).toBe(Precision.UNKNOWN)
  })

  it('fileReadProvision returns UNKNOWN when any path is missing', async () => {
    await writeBytes(acc, spec('/a'), ENC.encode('x'))
    const r = await fileReadProvision(acc, [spec('/a'), spec('/ghost')], [], makeOpts())
    expect(r.precision).toBe(Precision.UNKNOWN)
  })

  it('headTailProvision mirrors fileReadProvision (Redis has no ranged GET)', async () => {
    await writeBytes(acc, spec('/big'), ENC.encode('abcdefghij'))
    const r = await headTailProvision(acc, [spec('/big')], [], makeOpts())
    expect(r.precision).toBe(Precision.EXACT)
    expect(r.networkReadLow).toBe(10)
    expect(r.networkReadHigh).toBe(10)
    expect(r.readOps).toBe(1)
  })

  it('metadataProvision reports zero bytes + readOps matching paths', () => {
    const r = metadataProvision(acc, [spec('/a'), spec('/b'), spec('/c')], [], makeOpts())
    expect(r.precision).toBe(Precision.EXACT)
    expect(r.networkReadLow).toBe(0)
    expect(r.networkReadHigh).toBe(0)
    expect(r.readOps).toBe(3)
  })

  it('metadataProvision defaults readOps to 1 when no paths', () => {
    const r = metadataProvision(acc, [], [], makeOpts())
    expect(r.readOps).toBe(1)
  })
})
