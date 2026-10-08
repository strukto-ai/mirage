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
import { ioFor } from '@struktoai/mirage-core/test-utils'
import { EmailVFS } from '../../../vfs/email/email.ts'

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
  vfsPath: 'INBOX',
})
const ACCESSOR = { config: { maxMessages: 10 } } as unknown as EmailAccessor

async function run(texts: string[], flags: Record<string, FlagValue>) {
  const cmd = EMAIL_GREP[0]
  if (cmd === undefined) throw new Error('grep not registered')
  return cmd.fn(ACCESSOR, [FOLDER], texts, {
    stdin: null,
    flags,
    io: ioFor(EmailVFS, ACCESSOR),
    cwd: '/',
  })
}

beforeEach(() => {
  search.mockReset()
  generic.mockReset()
  generic.mockResolvedValue([new Uint8Array(), new IOResult()])
})

describe('email grep push-down', () => {
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
})
