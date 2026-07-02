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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./readdir.ts', () => ({
  readdir: vi.fn(),
}))

import { PostgresAccessor } from '../../accessor/postgres.ts'
import { PathSpec } from '../../types.ts'
import { resolvePostgresConfig } from '../../resource/postgres/config.ts'
import type { PgDriver } from './_driver.ts'
import { resolveGlob } from './glob.ts'
import { readdir } from './readdir.ts'

const STUB_DRIVER: PgDriver = {
  query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  close: () => Promise.resolve(),
}

function makeAccessor(): PostgresAccessor {
  const cfg = resolvePostgresConfig({ dsn: 'postgres://localhost/db' })
  return new PostgresAccessor(STUB_DRIVER, cfg)
}

describe('resolveGlob', () => {
  beforeEach(() => {
    vi.mocked(readdir).mockReset()
  })

  it('passes through resolved paths unchanged', async () => {
    const p = new PathSpec({
      resourcePath: 'pg/public',
      virtual: '/pg/public',
      directory: '/pg/',
    })
    expect(await resolveGlob(makeAccessor(), [p])).toEqual([p])
  })

  it('expands * pattern against readdir output, preserving prefix', async () => {
    vi.mocked(readdir).mockResolvedValue([
      '/pg/public/tables/users',
      '/pg/public/tables/orders',
      '/pg/public/tables/teams',
    ])
    const p = new PathSpec({
      virtual: '/pg/public/tables/u*',
      directory: '/pg/public/tables/',
      pattern: 'u*',
      resolved: false,
      resourcePath: mountKey('/pg/public/tables/u*', '/pg'),
    })
    const out = await resolveGlob(makeAccessor(), [p])
    expect(out.map((x) => x.virtual)).toEqual(['/pg/public/tables/users'])
    expect(
      out[0] === undefined ? undefined : mountPrefixOf(out[0].virtual, out[0].resourcePath),
    ).toBe('/pg')
  })

  it('passes through unresolved-but-no-pattern paths unchanged', async () => {
    const p = new PathSpec({
      resourcePath: 'pg/public',
      virtual: '/pg/public',
      directory: '/pg/',
      resolved: false,
    })
    const out = await resolveGlob(makeAccessor(), [p])
    expect(out).toEqual([p])
    expect(readdir).not.toHaveBeenCalled()
  })
})
