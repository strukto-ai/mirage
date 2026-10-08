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

vi.mock('../../../core/mongodb/stat.ts', () => ({
  stat: vi.fn(),
}))

import { MongoDBAccessor } from '../../../accessor/mongodb.ts'
import { stubMongoDriver } from '../../../core/mongodb/_test_util.ts'
import * as statModule from '../../../core/mongodb/stat.ts'
import { resolveMongoDBConfig } from '../../../vfs/mongodb/config.ts'
import { PathSpec } from '../../../types.ts'
import { MONGODB_CAT } from './cat.ts'
import { ioFor } from '../../../test-utils.ts'
import { MongoDBVFSBase } from '../../../vfs/mongodb/mongodb.ts'

const STUB_DRIVER = stubMongoDriver()

function makeAccessor(): MongoDBAccessor {
  return new MongoDBAccessor(STUB_DRIVER, resolveMongoDBConfig({ uri: 'mongodb://h' }))
}

function mk(name: string): PathSpec {
  return new PathSpec({
    virtual: `/mongo/app/${name}`,
    directory: '/mongo/app/',
    resolved: true,
    vfsPath: mountKey(`/mongo/app/${name}`, '/mongo'),
  })
}

describe('mongodb cat error surfacing', () => {
  beforeEach(() => {
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
        io: ioFor(MongoDBVFSBase, accessor),
        cwd: '/',
      }),
    ).rejects.toThrow(message)
  })
})
