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
  return { ...actual, googleGet: vi.fn(), googlePost: vi.fn() }
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
  return { stdin: null, flags, filetypeFns: null, cwd: '/', resource: {} as Resource }
}

describe('gws dispatcher', () => {
  it('normalizes official flag aliases', () => {
    expect(normalizeFlags({ 'spreadsheet-id': 's1', range: 'A1', 'document-id': 'd1' })).toEqual({
      spreadsheet: 's1',
      range: 'A1',
      document: 'd1',
    })
  })

  it('routes a discovery method through the table', async () => {
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

  it('routes create through the table', async () => {
    vi.mocked(client.googlePost).mockResolvedValue({ documentId: 'd2' })
    const result = await gwsDispatch(
      ACCESSOR,
      [],
      ['docs', 'documents', 'create'],
      makeOpts({ json: '{"title": "T"}' }),
    )
    if (result === null) throw new Error('expected result')
    expect(result[1].exitCode).toBe(0)
    expect(client.googlePost).toHaveBeenCalled()
  })

  it('routes +read to the helper with aliases applied', async () => {
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

  it('rejects unknown methods, helpers, and usage', async () => {
    for (const words of [['docs', 'documents', 'destroy'], ['docs', '+nope'], ['docs']]) {
      const r = await gwsDispatch(ACCESSOR, [], words, makeOpts({}))
      if (r === null) throw new Error('expected result')
      expect(r[1].exitCode).toBe(2)
    }
  })
})
