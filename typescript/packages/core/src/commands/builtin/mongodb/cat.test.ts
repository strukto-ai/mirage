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

import { mountKey } from '../../../utils/key_prefix.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../core/mongodb/read.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  streamAny: vi.fn(),
}))
vi.mock('../../../core/mongodb/stat.ts', () => ({
  stat: vi.fn(),
}))

import { MongoDBAccessor } from '../../../accessor/mongodb.ts'
import { stubMongoDriver } from '../../../core/mongodb/_test_util.ts'
import * as readModule from '../../../core/mongodb/read.ts'
import * as statModule from '../../../core/mongodb/stat.ts'
import { resolveMongoDBConfig } from '../../../resource/mongodb/config.ts'
import { materialize } from '../../../io/types.ts'
import { FileStat, PathSpec } from '../../../types.ts'
import { MONGODB_CAT } from './cat.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()
const STUB_DRIVER = stubMongoDriver()

function makeAccessor(): MongoDBAccessor {
  return new MongoDBAccessor(STUB_DRIVER, resolveMongoDBConfig({ uri: 'mongodb://h' }))
}

function mk(name: string): PathSpec {
  return new PathSpec({
    virtual: `/mongo/app/${name}`,
    directory: '/mongo/app/',
    resolved: true,
    resourcePath: mountKey(`/mongo/app/${name}`, '/mongo'),
  })
}

async function* bytesFor(path: PathSpec | string): AsyncIterable<Uint8Array> {
  const original = typeof path === 'string' ? path : path.virtual
  yield await Promise.resolve(ENC.encode(original.endsWith('a.jsonl') ? 'AAA\n' : 'BBB\n'))
}

describe('mongodb cat error surfacing', () => {
  beforeEach(() => {
    vi.mocked(readModule.streamAny).mockReset()
    vi.mocked(statModule.stat).mockReset()
  })

  it('rejects with the backend error when stat() throws', async () => {
    const message = 'simulated mongo failure'
    vi.mocked(statModule.stat).mockRejectedValue(new Error(message))
    const cmd = MONGODB_CAT[0]
    if (cmd === undefined) throw new Error('cat not registered')
    const accessor = makeAccessor()
    await expect(
      cmd.fn(accessor, [mk('users.jsonl')], [], {
        stdin: null,
        flags: {},
        filetypeFns: null,
        cwd: '/',
        resource: { kind: 'mongodb' } as never,
      }),
    ).rejects.toThrow(message)
  })

  it('concatenates all files when multiple paths are given', async () => {
    vi.mocked(statModule.stat).mockResolvedValue(new FileStat({ name: 'documents.jsonl' }))
    vi.mocked(readModule.streamAny).mockImplementation((_accessor, path) => bytesFor(path))
    const cmd = MONGODB_CAT[0]
    if (cmd === undefined) throw new Error('cat not registered')
    const accessor = makeAccessor()
    const result = await cmd.fn(accessor, [mk('a.jsonl'), mk('b.jsonl')], [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
      resource: { kind: 'mongodb' } as never,
    })
    expect(result).not.toBeNull()
    if (result === null) return
    const [out, io] = result
    expect(io.exitCode).toBe(0)
    const bytes = await materialize(out)
    expect(DEC.decode(bytes)).toBe('AAA\nBBB\n')
    expect(Object.keys(io.reads).sort()).toEqual(['/app/a.jsonl', '/app/b.jsonl'])
  })
})
