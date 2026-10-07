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
vi.mock('../../../core/mongodb/client.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findDocuments: vi.fn(),
}))
vi.mock('../../../core/mongodb/stream.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  watchStream: vi.fn(),
}))

import { MongoDBAccessor } from '../../../accessor/mongodb.ts'
import { stubMongoDriver } from '../../../core/mongodb/_test_util.ts'
import * as clientModule from '../../../core/mongodb/client.ts'
import * as readModule from '../../../core/mongodb/read.ts'
import * as statModule from '../../../core/mongodb/stat.ts'
import * as streamModule from '../../../core/mongodb/stream.ts'
import { resolveMongoDBConfig } from '../../../vfs/mongodb/config.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { FlagValue } from '../../spec/types.ts'
import { MONGODB_COMMANDS } from './index.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()
// The change stream proves its collection through the entity guard first, so
// the catalog holds the database and collections the tests name.
const STUB_DRIVER = stubMongoDriver({
  listDatabases: () => Promise.resolve(['app', 'secret']),
  listCollections: () => Promise.resolve(['users', 'orders']),
})

function makeAccessor(databases?: string[]): MongoDBAccessor {
  return new MongoDBAccessor(
    STUB_DRIVER,
    resolveMongoDBConfig({ uri: 'mongodb://h', ...(databases === undefined ? {} : { databases }) }),
  )
}

function docs(name: string): PathSpec {
  const virtual = `/mongo/app/collections/${name}/documents.jsonl`
  return new PathSpec({
    virtual,
    directory: `/mongo/app/collections/${name}/`,
    resolved: true,
    vfsPath: mountKey(virtual, '/mongo'),
  })
}

async function* lines(): AsyncGenerator<Uint8Array> {
  yield await Promise.resolve(ENC.encode('{"a":1}\n'))
}

async function run(
  paths: PathSpec[],
  flags: Record<string, FlagValue>,
  signal?: AbortSignal,
  accessor: MongoDBAccessor = makeAccessor(),
): Promise<AsyncIterable<Uint8Array> | Uint8Array | null> {
  const cmd = MONGODB_COMMANDS.find((cmd) => cmd.name === 'tail')
  if (cmd === undefined) throw new Error('tail not registered')
  const result = await cmd.fn(accessor, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    ...(signal === undefined ? {} : { signal }),
  })
  if (result === null) throw new Error('tail returned nothing')
  return result[0] as AsyncIterable<Uint8Array> | Uint8Array | null
}

describe('mongodb tail pushdown', () => {
  beforeEach(() => {
    vi.mocked(readModule.streamAny).mockReset()
    vi.mocked(statModule.stat).mockReset()
    vi.mocked(clientModule.findDocuments).mockReset()
    vi.mocked(streamModule.watchStream).mockReset()
    vi.mocked(statModule.stat).mockResolvedValue(
      new FileStat({ name: 'documents.jsonl', type: FileType.FILE, size: null }),
    )
    vi.mocked(readModule.streamAny).mockImplementation(() => lines())
  })

  it.each([{ follow: true }, { F: true }])(
    'follows one collection as a change stream (%o)',
    async (mode) => {
      vi.mocked(streamModule.watchStream).mockImplementation(() => lines())
      await run([docs('users')], mode)
      expect(streamModule.watchStream).toHaveBeenCalledTimes(1)
      expect(clientModule.findDocuments).not.toHaveBeenCalled()
    },
  )

  // The change stream queried the collection by the names in the path, so a
  // database `databases` leaves out was followed while `ls` and `cat` said it
  // was not there.
  it('does not follow a collection outside databases', async () => {
    vi.mocked(streamModule.watchStream).mockImplementation(() => lines())
    const virtual = '/mongo/secret/collections/users/documents.jsonl'
    const secret = new PathSpec({
      virtual,
      directory: '/mongo/secret/collections/users/',
      resolved: true,
      vfsPath: mountKey(virtual, '/mongo'),
    })
    await run([secret], { follow: true }, undefined, makeAccessor(['app']))
    expect(streamModule.watchStream).not.toHaveBeenCalled()
  })

  it('reads every collection whole when a follow polls more than one', async () => {
    // The pushed-down suffix moves with the collection and has no byte
    // position to measure against, so a polled follow streams it whole.
    vi.mocked(clientModule.findDocuments).mockRejectedValue(
      new Error('pushdown ran under a follow'),
    )
    const abort = new AbortController()
    const out = await run(
      [docs('users'), docs('orders')],
      { follow: true, sleep_interval: '0.02' },
      abort.signal,
    )
    if (out === null || out instanceof Uint8Array) throw new Error('a follow is a stream')
    setTimeout(() => {
      abort.abort()
    }, 100)
    let shown = ''
    for await (const chunk of out) shown += DEC.decode(chunk)
    expect(shown).toContain('==> /mongo/app/collections/users/documents.jsonl <==\n{"a":1}\n')
    expect(shown).toContain('==> /mongo/app/collections/orders/documents.jsonl <==\n{"a":1}\n')
    expect(clientModule.findDocuments).not.toHaveBeenCalled()
    expect(vi.mocked(readModule.streamAny).mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
