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

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../core/mongodb/read.ts', () => ({
  read: vi.fn(),
}))

import { MongoDBAccessor } from '../../../accessor/mongodb.ts'
import { stubMongoDriver } from '../../../core/mongodb/_test_util.ts'
import * as readModule from '../../../core/mongodb/read.ts'
import { resolveMongoDBConfig } from '../../../resource/mongodb/config.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { MONGODB_CAT } from './cat.ts'

const DEC = new TextDecoder()

const STUB_DRIVER = stubMongoDriver()

function makeAccessor(): MongoDBAccessor {
  return new MongoDBAccessor(STUB_DRIVER, resolveMongoDBConfig({ uri: 'mongodb://h' }))
}

describe('mongodb cat error surfacing', () => {
  beforeEach(() => {
    vi.mocked(readModule.read).mockReset()
  })

  it('returns exitCode=1 with stderr when read() throws', async () => {
    const message = 'simulated mongo failure'
    vi.mocked(readModule.read).mockRejectedValue(new Error(message))

    const cmd = MONGODB_CAT[0]
    if (cmd === undefined) throw new Error('cat not registered')
    const accessor = makeAccessor()
    const path = new PathSpec({
      original: '/mongo/app/users.jsonl',
      directory: '/mongo/app/',
      resolved: true,
      prefix: '/mongo',
    })
    const result = await cmd.fn(accessor, [path], [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
      resource: { kind: 'mongodb' } as never,
    })
    expect(result).not.toBeNull()
    if (result === null) return
    const [out, io] = result
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(io.stderr).not.toBeNull()
    const stderrBytes = await materialize(io.stderr)
    expect(DEC.decode(stderrBytes)).toContain(message)
  })
})
