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

import { invoke } from '../../../io/stdio.ts'
import { describe, expect, it } from 'vitest'
import { MongoDBAccessor } from '../../../accessor/mongodb.ts'
import { stubMongoDriver } from '../../../core/mongodb/_test_util.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { resolveMongoDBConfig } from '../../../vfs/mongodb/config.ts'
import { MONGODB_WC } from './wc.ts'
import { ioFor } from '../../../test-utils.ts'
import { MongoDBVFSBase } from '../../../vfs/mongodb/mongodb.ts'

function docs(name: string): PathSpec {
  const virtual = `/mongo/app/collections/${name}/documents.jsonl`
  return new PathSpec({
    virtual,
    directory: `/mongo/app/collections/${name}/`,
    resolved: true,
    vfsPath: mountKey(virtual, '/mongo'),
  })
}

async function wcLines(path: PathSpec, counted: string[]): Promise<[string, number, string]> {
  const cmd = MONGODB_WC[0]
  if (cmd === undefined) throw new Error('wc not registered')
  const driver = stubMongoDriver({
    listDatabases: () => Promise.resolve(['app']),
    listCollections: () => Promise.resolve(['users']),
    countDocuments: (_database, collection) => {
      counted.push(collection)
      return Promise.resolve(7)
    },
  })
  const accessor = new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h' }))
  const result = await invoke(() =>
    cmd.fn(accessor, [path], [], {
      stdin: null,
      flags: { lines: true },
      io: ioFor(MongoDBVFSBase, accessor),
      cwd: '/',
    }),
  )
  if (result === null) throw new Error('wc returned nothing')
  const [out, io] = result
  const dec = new TextDecoder()
  return [dec.decode(await materialize(out)), io.exitCode, dec.decode(await materialize(io.stderr))]
}

describe('mongodb wc -l', () => {
  it('counts a visible collection server-side', async () => {
    const counted: string[] = []
    const [stdout, code] = await wcLines(docs('users'), counted)
    expect(stdout).toBe('7 /mongo/app/collections/users/documents.jsonl\n')
    expect(code).toBe(0)
    expect(counted).toEqual(['users'])
  })
})
