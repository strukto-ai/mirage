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

import { stripSlash } from '../../utils/slash.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./readdir.ts', () => ({
  readdir: vi.fn(),
}))

import { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { resolveMongoDBConfig } from '../../resource/mongodb/config.ts'
import { PathSpec } from '../../types.ts'
import { stubMongoDriver } from './_test_util.ts'
import { resolveGlob } from './glob.ts'
import { readdir } from './readdir.ts'

const STUB_DRIVER = stubMongoDriver()

function makeAccessor(): MongoDBAccessor {
  return new MongoDBAccessor(STUB_DRIVER, resolveMongoDBConfig({ uri: 'mongodb://h' }))
}

describe('resolveGlob', () => {
  beforeEach(() => {
    vi.mocked(readdir).mockReset()
  })

  it('passes through resolved paths unchanged', async () => {
    const p = new PathSpec({
      resourcePath: stripSlash('/mongo/app'),
      virtual: '/mongo/app',
      directory: '/mongo/',
    })
    expect(await resolveGlob(makeAccessor(), [p])).toEqual([p])
  })

  it('expands * pattern, preserving prefix', async () => {
    vi.mocked(readdir).mockResolvedValue([
      '/mongo/app/users.jsonl',
      '/mongo/app/orders.jsonl',
      '/mongo/app/usage.jsonl',
    ])
    const p = new PathSpec({
      virtual: '/mongo/app/u*.jsonl',
      directory: '/mongo/app/',
      pattern: 'u*.jsonl',
      resolved: false,
      resourcePath: mountKey('/mongo/app/u*.jsonl', '/mongo'),
    })
    const out = await resolveGlob(makeAccessor(), [p])
    expect(out.map((x) => x.virtual)).toEqual(['/mongo/app/users.jsonl', '/mongo/app/usage.jsonl'])
    expect(
      out[0] === undefined ? undefined : mountPrefixOf(out[0].virtual, out[0].resourcePath),
    ).toBe('/mongo')
  })
})
