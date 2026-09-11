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

// The SEARCHERS map is rebuilt over the mocked searchEntity: the real map
// closes over the module-local binding, which a module mock cannot reach.
vi.mock('../../../core/postgres/search.ts', () => {
  const searchEntity = vi.fn()
  const viaEntity = async (): Promise<string[]> => {
    await (searchEntity as () => Promise<unknown>)()
    return []
  }
  return {
    searchEntity,
    searchKind: vi.fn(),
    searchSchema: vi.fn(),
    searchDatabase: vi.fn(),
    searchEntityMetadata: vi.fn(() => []),
    searchKindMetadata: vi.fn(() => []),
    searchSchemaMetadata: vi.fn(() => []),
    searchDatabaseMetadata: vi.fn(() => []),
    formatGrepResults: vi.fn(() => []),
    SEARCHERS: {
      root: vi.fn(() => Promise.resolve([])),
      schema: vi.fn(() => Promise.resolve([])),
      kind: vi.fn(() => Promise.resolve([])),
      entity: viaEntity,
      entity_rows: viaEntity,
    },
  }
})
vi.mock('../../../core/postgres/stat.ts', () => ({ stat: vi.fn() }))
// When the push-down is skipped the wrapper falls through to the generic
// scan, which reads the rendered file; stub the read so those cases exercise
// only the push-down/no-push-down decision, not real row fetching.
vi.mock('../../../core/postgres/read.ts', () => ({
  read: vi.fn(() => Promise.resolve(new Uint8Array(0))),
  // eslint-disable-next-line @typescript-eslint/require-await
  readStream: vi.fn(async function* () {
    yield new Uint8Array(0)
  }),
}))

import { PostgresAccessor } from '../../../accessor/postgres.ts'
import type { PgDriver, PgQueryResult } from '../../../core/postgres/_driver.ts'
import * as searchModule from '../../../core/postgres/search.ts'
import * as statModule from '../../../core/postgres/stat.ts'
import { resolvePostgresConfig } from '../../../resource/postgres/config.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../../types.ts'
import { hasUnresolvedGlob } from '../utils/operands.ts'
import { POSTGRES_COMMANDS } from './index.ts'

const POSTGRES_GREP = POSTGRES_COMMANDS.filter((c) => c.name === 'grep' && c.filetype == null)
const POSTGRES_RG = POSTGRES_COMMANDS.filter((c) => c.name === 'rg' && c.filetype == null)

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

// The dispatcher hands a glob operand through with the trailing segment in
// `pattern` and the wildcard still in `directory`; detectScope would
// otherwise read the "*" as an entity literally named "*".
function globPath(): PathSpec {
  return new PathSpec({
    virtual: '/public/tables/*/rows.jsonl',
    directory: '/public/tables/',
    resourcePath: 'public/tables/*/rows.jsonl',
    pattern: 'rows.jsonl',
    resolved: false,
  })
}

function concretePath(): PathSpec {
  return new PathSpec({
    virtual: '/public/tables/books/rows.jsonl',
    directory: '/public/tables/books/',
    resourcePath: 'public/tables/books/rows.jsonl',
    resolved: true,
  })
}

describe('hasUnresolvedGlob', () => {
  it('is false for concrete operands', () => {
    expect(hasUnresolvedGlob([concretePath()])).toBe(false)
  })

  it('is false for no operands', () => {
    expect(hasUnresolvedGlob([])).toBe(false)
  })

  it('is true when any operand still carries a pattern', () => {
    expect(hasUnresolvedGlob([concretePath(), globPath()])).toBe(true)
  })
})

describe('postgres grep push-down and globs', () => {
  beforeEach(() => {
    vi.mocked(searchModule.searchEntity).mockReset()
    vi.mocked(statModule.stat).mockReset()
  })

  it('skips the SQL push-down when the operand is an unresolved glob', async () => {
    const cmd = POSTGRES_GREP[0]
    if (cmd === undefined) throw new Error('grep not registered')
    // stat must resolve here: glob expansion legitimately stats the paths it
    // discovers, so only searchEntity discriminates "push-down ran" from
    // "push-down was skipped". Before the fix, detectScope read the "*" as an
    // entity and searchEntity was called with it. It resolves with a real
    // stat because the generic scan reads the type to tell a file operand
    // from a directory one, which is what the backend answers here.
    vi.mocked(statModule.stat).mockResolvedValue(
      new FileStat({ name: 'rows.jsonl', type: FileType.FILE, content: ContentType.TEXT }),
    )
    vi.mocked(searchModule.searchEntity).mockResolvedValue([])

    const result = await cmd.fn(makeAccessor(), [globPath()], ['ada'], {
      stdin: null,
      // `args_l`, not a bare `l`: flagKwargName maps the ambiguous short
      // `-l` onto `args_l` in both languages, so the dispatcher never emits
      // `l` and a spec-bound FlagView refuses to read one.
      flags: { args_l: true },
      filetypeFns: null,
      cwd: '/',
    })

    expect(result).not.toBeNull()
    expect(vi.mocked(searchModule.searchEntity)).not.toHaveBeenCalled()
  })

  it('still uses the SQL push-down for a concrete operand', async () => {
    const cmd = POSTGRES_GREP[0]
    if (cmd === undefined) throw new Error('grep not registered')
    vi.mocked(statModule.stat).mockResolvedValue(undefined as never)
    vi.mocked(searchModule.searchEntity).mockResolvedValue([])

    await cmd.fn(makeAccessor(), [concretePath()], ['ada'], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
    })

    expect(vi.mocked(searchModule.searchEntity)).toHaveBeenCalledTimes(1)
  })

  it.each([{ v: true }, { c: true }, { args_l: true }, { n: true }])(
    'skips the SQL push-down when a shaping flag is set (%j)',
    async (flags) => {
      const cmd = POSTGRES_GREP[0]
      if (cmd === undefined) throw new Error('grep not registered')
      // A shaping flag cannot be honored by the ILIKE push-down, so the
      // wrapper must defer to the generic scan; searchEntity must not run.
      vi.mocked(statModule.stat).mockResolvedValue(
        new FileStat({ name: 'rows.jsonl', type: FileType.FILE, content: ContentType.TEXT }),
      )
      vi.mocked(searchModule.searchEntity).mockResolvedValue([])

      await cmd.fn(makeAccessor(), [concretePath()], ['ada'], {
        stdin: null,
        flags,
        filetypeFns: null,
        cwd: '/',
      })

      expect(vi.mocked(searchModule.searchEntity)).not.toHaveBeenCalled()
    },
  )

  it('skips the SQL push-down for a regex pattern', async () => {
    const cmd = POSTGRES_GREP[0]
    if (cmd === undefined) throw new Error('grep not registered')
    vi.mocked(statModule.stat).mockResolvedValue(
      new FileStat({ name: 'rows.jsonl', type: FileType.FILE, content: ContentType.TEXT }),
    )
    vi.mocked(searchModule.searchEntity).mockResolvedValue([])

    await cmd.fn(makeAccessor(), [concretePath()], ['a.b'], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
    })

    expect(vi.mocked(searchModule.searchEntity)).not.toHaveBeenCalled()
  })
})

describe('postgres rg push-down and globs', () => {
  beforeEach(() => {
    vi.mocked(searchModule.searchEntity).mockReset()
    vi.mocked(statModule.stat).mockReset()
  })

  it('skips the SQL push-down when the operand is an unresolved glob', async () => {
    const cmd = POSTGRES_RG[0]
    if (cmd === undefined) throw new Error('rg not registered')
    vi.mocked(statModule.stat).mockResolvedValue(
      new FileStat({ name: 'rows.jsonl', type: FileType.FILE, content: ContentType.TEXT }),
    )
    vi.mocked(searchModule.searchEntity).mockResolvedValue([])

    await cmd.fn(makeAccessor(), [globPath()], ['ada'], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
    })

    expect(vi.mocked(searchModule.searchEntity)).not.toHaveBeenCalled()
  })

  it('still uses the SQL push-down for a concrete operand', async () => {
    const cmd = POSTGRES_RG[0]
    if (cmd === undefined) throw new Error('rg not registered')
    vi.mocked(statModule.stat).mockResolvedValue(undefined as never)
    vi.mocked(searchModule.searchEntity).mockResolvedValue([])

    await cmd.fn(makeAccessor(), [concretePath()], ['ada'], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
    })

    expect(vi.mocked(searchModule.searchEntity)).toHaveBeenCalledTimes(1)
  })

  it.each([{ v: true }, { c: true }, { args_l: true }, { n: true }])(
    'skips the SQL push-down when a shaping flag is set (%j)',
    async (flags) => {
      const cmd = POSTGRES_RG[0]
      if (cmd === undefined) throw new Error('rg not registered')
      vi.mocked(statModule.stat).mockResolvedValue(
        new FileStat({ name: 'rows.jsonl', type: FileType.FILE, content: ContentType.TEXT }),
      )
      vi.mocked(searchModule.searchEntity).mockResolvedValue([])

      await cmd.fn(makeAccessor(), [concretePath()], ['ada'], {
        stdin: null,
        flags,
        filetypeFns: null,
        cwd: '/',
      })

      expect(vi.mocked(searchModule.searchEntity)).not.toHaveBeenCalled()
    },
  )
})
