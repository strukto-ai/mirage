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
vi.mock('@struktoai/mirage-core/commands/builtin/generic/rg', () => ({ rgGeneric: vi.fn() }))
vi.mock('@struktoai/mirage-core/commands/builtin/generic_bind/index', async (importOriginal) => ({
  ...(await importOriginal<typeof BindModule>()),
  resolveGlobOf: () => (_accessor: unknown, paths: PathSpec[]) => Promise.resolve(paths),
}))

import { rgGeneric } from '@struktoai/mirage-core/commands/builtin/generic/rg'
import type { FlagValue } from '@struktoai/mirage-core/commands/spec/types'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { PathSpec } from '@struktoai/mirage-core/types'
import type { EmailAccessor } from '../../../accessor/email.ts'
import { searchAndFormat } from '../../../core/email/search.ts'
import { EMAIL_RG } from './rg.ts'

const search = vi.mocked(searchAndFormat)
const generic = vi.mocked(rgGeneric)

const FOLDER = new PathSpec({
  virtual: '/email/INBOX',
  directory: '/email/INBOX',
  resourcePath: 'INBOX',
})
const ACCESSOR = { config: { maxMessages: 10 } } as unknown as EmailAccessor

async function run(texts: string[], flags: Record<string, FlagValue>) {
  const cmd = EMAIL_RG[0]
  if (cmd === undefined) throw new Error('rg not registered')
  return cmd.fn(ACCESSOR, [FOLDER], texts, { stdin: null, flags, filetypeFns: null, cwd: '/' })
}

beforeEach(() => {
  search.mockReset()
  search.mockResolvedValue([])
  generic.mockReset()
  generic.mockResolvedValue([new Uint8Array(), new IOResult()])
})

describe('email rg push-down', () => {
  it('defers an alternation to the generic scan', async () => {
    // No literal is required by every match of `parser|percent`, and IMAP
    // TEXT is a substring search, so the push-down cannot narrow it: the
    // generic scan runs instead of answering exit 1 (#1067).
    await run(['parser|percent'], {})
    expect(search).not.toHaveBeenCalled()
    expect(generic).toHaveBeenCalledTimes(1)
  })

  it('hands the server the literal a regex requires', async () => {
    // `worker.3` matches `worker-3`; the server is asked for `worker`.
    const [, io] = (await run(['worker.3'], {})) as [Uint8Array, IOResult]
    expect(search.mock.calls[0]?.[2]).toBe('worker')
    expect(io.exitCode).toBe(1)
    expect(generic).not.toHaveBeenCalled()
  })
})
