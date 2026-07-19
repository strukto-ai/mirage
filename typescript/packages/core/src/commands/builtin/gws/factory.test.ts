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
import { fillPath, runGwsMethod } from './factory.ts'
import { GWS_METHODS } from './methods.ts'

const DEC = new TextDecoder()

const METHODS = new Map(GWS_METHODS.map((m) => [`${m.service}.${m.resource}.${m.method}`, m]))

const ACCESSOR = {
  tokenManager: { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager,
} as GoogleApiAccessor

function makeOpts(flags: CommandOpts['flags']): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: {} as Resource,
  }
}

function method(key: string) {
  const m = METHODS.get(key)
  if (m === undefined) throw new Error(`no method ${key}`)
  return m
}

describe('gws api factory', () => {
  it('fillPath substitutes and leaves query params', () => {
    const [path, query] = fillPath('/files/{fileId}/permissions', { fileId: 'f1', pageSize: 5 })
    expect(path).toBe('/files/f1/permissions')
    expect(query).toEqual({ pageSize: 5 })
    expect(() => fillPath('/files/{fileId}', {})).toThrow('must contain fileId')
  })

  it('documents get hits the docs api', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ documentId: 'd1', title: 'T' })
    const result = await runGwsMethod(
      method('docs.documents.get'),
      ACCESSOR,
      [],
      [],
      makeOpts({ params: '{"documentId": "d1"}' }),
    )
    if (result === null) throw new Error('expected result')
    const [out, io] = result
    expect(io.exitCode).toBe(0)
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual({ documentId: 'd1', title: 'T' })
    const url = vi.mocked(client.googleGet).mock.calls.at(-1)?.[1]
    expect(url).toMatch(/\/v1\/documents\/d1$/)
  })

  it('files list passes query params', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({ files: [] })
    await runGwsMethod(
      method('drive.files.list'),
      ACCESSOR,
      [],
      [],
      makeOpts({ params: '{"q": "trashed=false", "pageSize": 10}' }),
    )
    const call = vi.mocked(client.googleGet).mock.calls.at(-1)
    expect(call?.[2]).toEqual({ q: 'trashed=false', pageSize: '10' })
  })

  it('files delete outputs nothing', async () => {
    vi.mocked(client.googleDelete).mockResolvedValue(undefined)
    const result = await runGwsMethod(
      method('drive.files.delete'),
      ACCESSOR,
      [],
      [],
      makeOpts({ params: '{"fileId": "f1"}' }),
    )
    if (result === null) throw new Error('expected result')
    expect(result[0]).toBeNull()
    expect(result[1].exitCode).toBe(0)
  })

  it('files create requires a body', async () => {
    const result = await runGwsMethod(method('drive.files.create'), ACCESSOR, [], [], makeOpts({}))
    if (result === null) throw new Error('expected result')
    expect(result[1].exitCode).toBe(2)
  })

  it('permissions create posts the body', async () => {
    vi.mocked(client.googlePost).mockResolvedValue({ id: 'p1' })
    const result = await runGwsMethod(
      method('drive.permissions.create'),
      ACCESSOR,
      [],
      [],
      makeOpts({ params: '{"fileId": "f1"}', json: '{"role": "reader", "type": "anyone"}' }),
    )
    if (result === null) throw new Error('expected result')
    expect(DEC.decode(result[0] as Uint8Array)).toBe('{"id":"p1"}')
    const call = vi.mocked(client.googlePost).mock.calls.at(-1)
    expect(call?.[1]).toMatch(/\/files\/f1\/permissions$/)
    expect(call?.[2]).toEqual({ role: 'reader', type: 'anyone' })
  })

  it('files export returns raw bytes', async () => {
    vi.mocked(client.googleGetBytes).mockResolvedValue(new TextEncoder().encode('%PDF-1.4'))
    const result = await runGwsMethod(
      method('drive.files.export'),
      ACCESSOR,
      [],
      [],
      makeOpts({ params: '{"fileId": "f1", "mimeType": "application/pdf"}' }),
    )
    if (result === null) throw new Error('expected result')
    expect(DEC.decode(result[0] as Uint8Array)).toBe('%PDF-1.4')
    const url = vi.mocked(client.googleGetBytes).mock.calls.at(-1)?.[1]
    expect(url).toContain('/files/f1/export?mimeType=application/pdf')
  })
})
