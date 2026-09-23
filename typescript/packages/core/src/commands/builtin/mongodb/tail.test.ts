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
import { MONGODB_TAIL } from './tail.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()
const STUB_DRIVER = stubMongoDriver()

function makeAccessor(): MongoDBAccessor {
  return new MongoDBAccessor(STUB_DRIVER, resolveMongoDBConfig({ uri: 'mongodb://h' }))
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
): Promise<AsyncIterable<Uint8Array> | Uint8Array | null> {
  const cmd = MONGODB_TAIL[0]
  if (cmd === undefined) throw new Error('tail not registered')
  const result = await cmd.fn(makeAccessor(), paths, [], {
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

  it('fetches only the last N documents for a plain tail', async () => {
    vi.mocked(clientModule.findDocuments).mockResolvedValue([])
    await run([docs('users')], { n: '1' })
    expect(clientModule.findDocuments).toHaveBeenCalledTimes(1)
    expect(readModule.streamAny).not.toHaveBeenCalled()
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
