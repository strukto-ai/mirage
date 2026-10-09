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
import { mountKey } from '../../../utils/key_prefix.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../core/postgres/client.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listSchemas: vi.fn(),
  listTables: vi.fn(),
  fetchColumns: vi.fn(),
  estimatedRowCount: vi.fn(),
  tableSizeBytes: vi.fn(),
  fetchRows: vi.fn(),
}))

import { PostgresAccessor } from '../../../accessor/postgres.ts'
import type { PgDriver, PgQueryResult } from '../../../core/postgres/_driver.ts'
import * as clientModule from '../../../core/postgres/client.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { resolvePostgresConfig } from '../../../vfs/postgres/config.ts'
import { POSTGRES_HEAD } from './head.ts'
import { ioFor } from '../../../test-utils.ts'
import { PostgresVFSBase } from '../../../vfs/postgres/postgres.ts'

class StubDriver implements PgDriver {
  query<R = Record<string, unknown>>(): Promise<PgQueryResult<R>> {
    return Promise.resolve({ rows: [] as R[], rowCount: 0 })
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

const ROWS = new PathSpec({
  virtual: '/pg/public/tables/users/rows.jsonl',
  directory: '/pg/public/tables/users/',
  resolved: true,
  vfsPath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
})

function table(n: number): void {
  const rows = Array.from({ length: n }, (_, id) => ({ id }))
  vi.mocked(clientModule.fetchRows).mockImplementation((_accessor, _schema, _entity, window) =>
    Promise.resolve(rows.slice(window.offset, window.offset + window.limit)),
  )
}

async function head(n: number, maxReadRows?: number): Promise<[string[], number, string]> {
  const cmd = POSTGRES_HEAD[0]
  if (cmd === undefined) throw new Error('head not registered')
  const accessor = new PostgresAccessor(
    new StubDriver(),
    resolvePostgresConfig({
      dsn: 'postgres://h/db',
      ...(maxReadRows === undefined ? {} : { maxReadRows }),
    }),
  )
  const result = await invoke(() =>
    cmd.fn(accessor, [ROWS], [], {
      stdin: null,
      flags: { lines: String(n) },
      io: ioFor(PostgresVFSBase, accessor),
      cwd: '/',
    }),
  )
  if (result === null) throw new Error('head returned nothing')
  const [out, io] = result
  const dec = new TextDecoder()
  const lines = dec
    .decode(await materialize(out))
    .split('\n')
    .filter((l) => l !== '')
  return [lines, io.exitCode, dec.decode(await materialize(io.stderr))]
}

describe('postgres head', () => {
  beforeEach(() => {
    vi.mocked(clientModule.listSchemas).mockResolvedValue(['public'])
    vi.mocked(clientModule.listTables).mockResolvedValue(['users'])
    vi.mocked(clientModule.fetchColumns).mockResolvedValue([])
    vi.mocked(clientModule.estimatedRowCount).mockResolvedValue(0)
    vi.mocked(clientModule.tableSizeBytes).mockResolvedValue(0)
  })

  // `defaultRowLimit` clamped the pushed-down count, so `head -n 5000` of a
  // 6000-row table printed 1000 lines with exit 0.
  it('prints every row asked for past the default', async () => {
    table(1500)
    const [lines, code, err] = await head(1200)
    expect(lines).toHaveLength(1200)
    expect([code, err]).toEqual([0, ''])
  })

  it('prints a table shorter than the ceiling whole', async () => {
    table(15)
    const [lines, code, err] = await head(25, 20)
    expect(lines).toHaveLength(15)
    expect([code, err]).toEqual([0, ''])
  })
})
