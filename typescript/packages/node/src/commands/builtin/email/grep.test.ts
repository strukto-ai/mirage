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

import type * as BindModule from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type * as SearchModule from '../../../core/email/search.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../core/email/search.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchModule>()),
  searchAndFormat: vi.fn(),
}))
vi.mock('@struktoai/mirage-core/commands/builtin/generic/grep', () => ({ grepGeneric: vi.fn() }))
vi.mock('@struktoai/mirage-core/commands/builtin/generic_bind/index', async (importOriginal) => ({
  ...(await importOriginal<typeof BindModule>()),
  resolveGlobOf: () => (_accessor: unknown, paths: PathSpec[]) => Promise.resolve(paths),
}))

import { grepGeneric } from '@struktoai/mirage-core/commands/builtin/generic/grep'
import type { FlagValue } from '@struktoai/mirage-core/commands/spec/types'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { PathSpec } from '@struktoai/mirage-core/types'
import type { EmailAccessor } from '../../../accessor/email.ts'
import { searchAndFormat } from '../../../core/email/search.ts'
import { EMAIL_GREP } from './grep.ts'

const search = vi.mocked(searchAndFormat)
const generic = vi.mocked(grepGeneric)
const DEC = new TextDecoder()

const FOLDER = new PathSpec({
  virtual: '/email/INBOX',
  directory: '/email/INBOX',
  resourcePath: 'INBOX',
})
const ACCESSOR = { config: { maxMessages: 10 } } as unknown as EmailAccessor

async function run(texts: string[], flags: Record<string, FlagValue>) {
  const cmd = EMAIL_GREP[0]
  if (cmd === undefined) throw new Error('grep not registered')
  return cmd.fn(ACCESSOR, [FOLDER], texts, { stdin: null, flags, filetypeFns: null, cwd: '/' })
}

beforeEach(() => {
  search.mockReset()
  generic.mockReset()
  generic.mockResolvedValue([new Uint8Array(), new IOResult()])
})

describe('email grep push-down', () => {
  it('defers an alternation to the generic scan', async () => {
    // IMAP TEXT is a substring search, not a regex engine. Handed
    // `parser|percent` verbatim it looked for that literal, matched
    // nothing, and grep answered exit 1 for a search GNU satisfies twice
    // over. With no literal every match must contain, only the generic
    // scan is faithful (#1067).
    await run(['parser|percent'], { r: true, E: true })
    expect(search).not.toHaveBeenCalled()
    expect(generic).toHaveBeenCalledTimes(1)
  })

  it('narrows a regex on its required literal and runs itself over each candidate', async () => {
    // A candidate the case-insensitive substring search returns but the
    // regex rejects contributes nothing.
    search.mockResolvedValue([
      ['/email/INBOX/a.email.json', 'the budget attached'],
      ['/email/INBOX/b.email.json', 'Q2 Budget Review'],
    ])
    const [out, io] = (await run(['budget[^"<]*'], { r: true })) as [Uint8Array, IOResult]
    expect(search.mock.calls[0]?.[2]).toBe('budget')
    expect(DEC.decode(out)).toBe('/email/INBOX/a.email.json:the budget attached\n')
    expect(io.exitCode).toBe(0)
    expect(generic).not.toHaveBeenCalled()
  })

  it('hands -F its pattern verbatim, quotes included', async () => {
    search.mockResolvedValue([])
    const [, io] = (await run(['say "hi"'], { r: true, F: true })) as [Uint8Array, IOResult]
    expect(search.mock.calls[0]?.[2]).toBe('say "hi"')
    expect(io.exitCode).toBe(1)
  })

  it('narrows an optional group on the run it requires', async () => {
    // `(forecast)?percent` matches a line holding only `percent`, so the
    // optional group's longer run is not the one the server is asked for.
    search.mockResolvedValue([['/email/INBOX/a.email.json', 'disk usage at 91 percent']])
    const [out, io] = (await run(['(forecast)?percent'], { r: true, E: true })) as [
      Uint8Array,
      IOResult,
    ]
    expect(search.mock.calls[0]?.[2]).toBe('percent')
    expect(DEC.decode(out)).toBe('/email/INBOX/a.email.json:disk usage at 91 percent\n')
    expect(io.exitCode).toBe(0)
  })

  it('reads a basic expression before narrowing', async () => {
    // Without -E the pattern is a basic expression: `\(...\)\?` is the
    // optional group there, so its run is skipped and `parser` is required.
    search.mockResolvedValue([['/email/INBOX/a.email.json', 'yesterday shipped the parser']])
    const [out, io] = (await run(['the \\(brand-new tokenizer or \\)\\?parser'], {
      r: true,
    })) as [Uint8Array, IOResult]
    expect(search.mock.calls[0]?.[2]).toBe('parser')
    expect(DEC.decode(out)).toBe('/email/INBOX/a.email.json:yesterday shipped the parser\n')
    expect(io.exitCode).toBe(0)
  })
})
