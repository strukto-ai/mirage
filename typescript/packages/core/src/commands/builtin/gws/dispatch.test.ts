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

import { describe, expect, it, vi } from 'vitest'
import type * as ClientModule from '../../../core/google/_client.ts'

vi.mock('../../../core/google/_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../../../core/google/_client.ts')
  return {
    ...actual,
    googleGet: vi.fn(),
    googleGetBytes: vi.fn(),
    googlePost: vi.fn(),
    googlePatch: vi.fn(),
    googleDelete: vi.fn(),
  }
})

import type { GoogleApiAccessor } from '../../../accessor/google_api.ts'
import type { TokenManager } from '../../../core/google/_client.ts'
import * as client from '../../../core/google/_client.ts'
import type { Resource } from '../../../resource/base.ts'
import type { CommandOpts } from '../../config.ts'
import { gwsDispatch, normalizeFlags } from './dispatch.ts'

const DEC = new TextDecoder()

const ACCESSOR = {
  tokenManager: { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager,
} as GoogleApiAccessor

function makeOpts(flags: CommandOpts['flags'] = {}): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: {} as Resource,
  }
}

describe('gws dispatcher', () => {
  it('normalizes official flag aliases', () => {
    expect(normalizeFlags({ 'spreadsheet-id': 's1', range: 'A1', 'document-id': 'd1' })).toEqual({
      spreadsheet: 's1',
      range: 'A1',
      document: 'd1',
    })
  })

  it('routes discovery methods to the passthrough factory', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ documentId: 'd1' })
    const result = await gwsDispatch(
      ACCESSOR,
      [],
      ['docs', 'documents', 'get'],
      makeOpts({ params: '{"documentId": "d1"}' }),
    )
    if (result === null) throw new Error('expected result')
    expect(result[1].exitCode).toBe(0)
    expect(DEC.decode(result[0] as Uint8Array)).toBe('{"documentId":"d1"}')
  })

  it('routes +read to the bespoke helper with aliases applied', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ values: [['a', 'b']] })
    const result = await gwsDispatch(
      ACCESSOR,
      [],
      ['sheets', '+read'],
      makeOpts({ 'spreadsheet-id': 's1', range: 'Sheet1!A1:B1' }),
    )
    if (result === null) throw new Error('expected result')
    expect(result[1].exitCode).toBe(0)
    const url = vi.mocked(client.googleGet).mock.calls.at(-1)?.[1]
    expect(url).toContain('/spreadsheets/s1/values/')
  })

  it('rejects unknown methods and helpers', async () => {
    const bad = await gwsDispatch(ACCESSOR, [], ['docs', 'documents', 'destroy'], makeOpts({}))
    if (bad === null) throw new Error('expected result')
    expect(bad[1].exitCode).toBe(2)
    const badPlus = await gwsDispatch(ACCESSOR, [], ['docs', '+nope'], makeOpts({}))
    if (badPlus === null) throw new Error('expected result')
    expect(badPlus[1].exitCode).toBe(2)
    const usage = await gwsDispatch(ACCESSOR, [], ['docs'], makeOpts({}))
    if (usage === null) throw new Error('expected result')
    expect(usage[1].exitCode).toBe(2)
  })
})
