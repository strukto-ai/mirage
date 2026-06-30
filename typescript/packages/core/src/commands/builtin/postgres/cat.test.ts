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

vi.mock('../../../core/postgres/read.ts', () => ({
  read: vi.fn(),
  readStream: vi.fn(),
}))
vi.mock('../../../core/postgres/stat.ts', () => ({
  stat: vi.fn(),
}))

import { PostgresAccessor } from '../../../accessor/postgres.ts'
import type { PgDriver, PgQueryResult } from '../../../core/postgres/_driver.ts'
import * as readModule from '../../../core/postgres/read.ts'
import * as statModule from '../../../core/postgres/stat.ts'
import { resolvePostgresConfig } from '../../../resource/postgres/config.ts'
import { materialize } from '../../../io/types.ts'
import { FileStat, PathSpec } from '../../../types.ts'
import { POSTGRES_COMMANDS } from './index.ts'

const POSTGRES_CAT = POSTGRES_COMMANDS.filter((c) => c.name === 'cat' && c.filetype == null)

class StubDriver implements PgDriver {
  query<R = Record<string, unknown>>(): Promise<PgQueryResult<R>> {
    return Promise.resolve({ rows: [] as R[], rowCount: 0 })
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

function makeAccessor(): PostgresAccessor {
  const cfg = resolvePostgresConfig({ dsn: 'postgres://h/db' })
  return new PostgresAccessor(new StubDriver(), cfg)
}

async function* failingStream(message: string): AsyncIterable<Uint8Array> {
  yield await Promise.reject(new Error(message))
}

describe('postgres cat size-guard surfacing', () => {
  beforeEach(() => {
    vi.mocked(readModule.readStream).mockReset()
    vi.mocked(statModule.stat).mockReset()
  })

  it('surfaces the size-guard error when the row read throws', async () => {
    const message =
      'public/tables/users/rows.jsonl too large to read entirely: ' +
      '~50000 rows / ~5000000 bytes (thresholds: 10000 rows / 1000000 bytes); ' +
      'use head, tail, wc, grep, or pass limit/offset'
    vi.mocked(statModule.stat).mockResolvedValue(new FileStat({ name: 'rows.jsonl' }))
    vi.mocked(readModule.readStream).mockImplementation(() => failingStream(message))

    const cmd = POSTGRES_CAT[0]
    if (cmd === undefined) throw new Error('cat not registered')
    const accessor = makeAccessor()
    const path = new PathSpec({
      original: '/pg/public/tables/users/rows.jsonl',
      directory: '/pg/public/tables/users/',
      resolved: true,
      prefix: '/pg',
    })
    const result = await cmd.fn(accessor, [path], [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
      resource: { kind: 'postgres' } as never,
    })
    expect(result).not.toBeNull()
    if (result === null) return
    const [out] = result
    await expect(materialize(out)).rejects.toThrow('too large to read entirely')
  })
})
