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

vi.mock('../../../core/postgres/read.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readStream: vi.fn(),
}))
vi.mock('../../../core/postgres/stat.ts', () => ({
  stat: vi.fn(),
}))
vi.mock('../../../core/postgres/client.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countRows: vi.fn(),
}))

import { PostgresAccessor } from '../../../accessor/postgres.ts'
import type { PgDriver, PgQueryResult } from '../../../core/postgres/_driver.ts'
import * as clientModule from '../../../core/postgres/client.ts'
import * as readModule from '../../../core/postgres/read.ts'
import * as statModule from '../../../core/postgres/stat.ts'
import { resolvePostgresConfig } from '../../../vfs/postgres/config.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { FlagValue } from '../../spec/types.ts'
import { POSTGRES_TAIL } from './tail.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

class StubDriver implements PgDriver {
  query<R = Record<string, unknown>>(): Promise<PgQueryResult<R>> {
    return Promise.resolve({ rows: [] as R[], rowCount: 0 })
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

function makeAccessor(): PostgresAccessor {
  return new PostgresAccessor(new StubDriver(), resolvePostgresConfig({ dsn: 'postgres://h/db' }))
}

const ROWS = new PathSpec({
  virtual: '/pg/public/tables/users/rows.jsonl',
  directory: '/pg/public/tables/users/',
  resolved: true,
  vfsPath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
})

async function* rows(): AsyncGenerator<Uint8Array> {
  yield await Promise.resolve(ENC.encode('{"id":1}\n{"id":2}\n'))
}

async function run(
  flags: Record<string, FlagValue>,
  signal?: AbortSignal,
): Promise<AsyncIterable<Uint8Array> | Uint8Array | null> {
  const cmd = POSTGRES_TAIL[0]
  if (cmd === undefined) throw new Error('tail not registered')
  const result = await cmd.fn(makeAccessor(), [ROWS], [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    ...(signal === undefined ? {} : { signal }),
  })
  if (result === null) throw new Error('tail returned nothing')
  return result[0] as AsyncIterable<Uint8Array> | Uint8Array | null
}

describe('postgres tail pushdown', () => {
  beforeEach(() => {
    vi.mocked(readModule.readStream).mockReset()
    vi.mocked(statModule.stat).mockReset()
    vi.mocked(clientModule.countRows).mockReset()
    vi.mocked(statModule.stat).mockResolvedValue(
      new FileStat({ name: 'rows.jsonl', type: FileType.FILE, size: null }),
    )
    vi.mocked(readModule.readStream).mockImplementation(() => rows())
  })

  it('fetches only the last N rows for a plain tail', async () => {
    vi.mocked(clientModule.countRows).mockResolvedValue(2)
    await run({ n: '1' })
    expect(clientModule.countRows).toHaveBeenCalledTimes(1)
    expect(vi.mocked(readModule.readStream).mock.calls[0]?.[3]).toEqual({ limit: 1, offset: 1 })
  })

  it.each([{ follow: true }, { F: true }])(
    'reads the relation whole under a follow (%o)',
    async (mode) => {
      // A follow polls the file as it grows; the pushed-down suffix moves
      // with the table and has no byte position to measure against.
      vi.mocked(clientModule.countRows).mockRejectedValue(new Error('pushdown ran under a follow'))
      const abort = new AbortController()
      const out = await run({ ...mode, sleep_interval: '0.02' }, abort.signal)
      if (out === null || out instanceof Uint8Array) throw new Error('a follow is a stream')
      const it = out[Symbol.asyncIterator]()
      const first = await it.next()
      abort.abort()
      await it.return?.()
      expect(DEC.decode(first.value as Uint8Array)).toBe('{"id":1}\n{"id":2}\n')
      expect(clientModule.countRows).not.toHaveBeenCalled()
      expect(vi.mocked(readModule.readStream).mock.calls[0]?.[3]).toBeUndefined()
    },
  )
})
