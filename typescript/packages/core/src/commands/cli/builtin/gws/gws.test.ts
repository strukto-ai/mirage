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
import type * as ClientModule from '../../../../core/google/_client.ts'

vi.mock('../../../../core/google/_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../../../../core/google/_client.ts')
  return {
    ...actual,
    googleGet: vi.fn(),
    googleGetBytes: vi.fn(),
    googlePost: vi.fn(),
    googlePatch: vi.fn(),
    googleDelete: vi.fn(),
  }
})

import * as client from '../../../../core/google/_client.ts'
import type { GoogleConfig } from '../../../../core/google/config.ts'
import { CLIRegistry } from '../../../../workspace/cli/registry.ts'
import type { CLIInvocation } from '../../types.ts'
import { cliSpecFor } from '../../specs.ts'
import { fillPath, runGwsMethod } from './api.ts'
import { GWS } from './index.ts'
import { GWS_METHODS } from './methods.ts'

const DEC = new TextDecoder()

const METHODS = new Map(GWS_METHODS.map((m) => [`${m.service}.${m.resource}.${m.method}`, m]))

const CONFIG: GoogleConfig = { clientId: 'cid', refreshToken: 'rt' }

function makeInv(config: GoogleConfig, flags: CLIInvocation['flags']): CLIInvocation<GoogleConfig> {
  return { config, argv: [], paths: [], texts: [], flags, stdin: null, env: {} }
}

function method(key: string) {
  const m = METHODS.get(key)
  if (m === undefined) throw new Error(`no method ${key}`)
  return m
}

function leaf(...path: string[]) {
  let node = GWS
  for (const name of path) {
    const child = node.subcommands.find((c) => c.name === name)
    if (child === undefined) throw new Error(`no subcommand ${name}`)
    node = child
  }
  return node
}

describe('gws tree', () => {
  it('lists every service and registers itself', () => {
    expect(GWS.subcommands.map((g) => g.name)).toEqual([
      'drive',
      'sheets',
      'docs',
      'slides',
      'gmail',
    ])
    expect(cliSpecFor('gws')).toBe(GWS)
  })

  it('nests passthroughs by discovery resource', () => {
    expect(leaf('drive', 'files').subcommands.map((v) => v.name)).toEqual([
      'list',
      'get',
      'create',
      'update',
      'copy',
      'delete',
      'export',
    ])
    expect(leaf('gmail', 'users', 'messages').subcommands.map((v) => v.name)).toEqual([
      'list',
      'get',
      'send',
      'trash',
      'attachments',
    ])
    expect(leaf('gmail', 'users', 'messages', 'attachments', 'get').fn).not.toBeNull()
  })

  it('keeps the bespoke verbs without the plus marker', () => {
    expect(
      leaf('gmail')
        .subcommands.slice(-6)
        .map((v) => v.name),
    ).toEqual(['send', 'read', 'reply', 'reply-all', 'forward', 'triage'])
    expect(
      leaf('sheets')
        .subcommands.slice(-3)
        .map((v) => v.name),
    ).toEqual(['read', 'write', 'append'])
    expect(leaf('docs', 'write').write).toBe(true)
    expect(leaf('drive', 'files', 'list').write).toBe(false)
    expect(leaf('drive', 'files', 'delete').write).toBe(true)
  })

  it('accepts and preserves a refreshFn callback at install time', () => {
    const refreshFn = () => Promise.resolve({ accessToken: 'a', expiresIn: 60 })
    const install = new CLIRegistry().install('gws', GWS, {
      clientId: 'cid',
      refreshToken: 'rt',
      refreshFn,
    })
    expect((install.config as GoogleConfig).refreshFn).toBe(refreshFn)
  })
})

describe('gws api passthrough', () => {
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
      makeInv(CONFIG, { params: '{"documentId": "d1"}' }),
    )
    if (result === null) throw new Error('expected result')
    const [out, io] = result
    expect(io.exitCode).toBe(0)
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual({ documentId: 'd1', title: 'T' })
    const url = vi.mocked(client.googleGet).mock.calls.at(-1)?.[1]
    expect(url).toMatch(/\/v1\/documents\/d1$/)
  })

  it('files list follows nextPageToken by default', async () => {
    vi.mocked(client.googleGet)
      .mockReset()
      .mockResolvedValueOnce({ files: [{ id: 'a' }], nextPageToken: 't1' })
      .mockResolvedValueOnce({ files: [{ id: 'b' }], nextPageToken: 't2' })
      .mockResolvedValueOnce({ files: [{ id: 'c' }] })
    const result = await runGwsMethod(method('drive.files.list'), makeInv(CONFIG, {}))
    if (result === null) throw new Error('expected result')
    expect(result[1].exitCode).toBe(0)
    const calls = vi.mocked(client.googleGet).mock.calls
    expect(calls.length).toBe(3)
    expect(calls.map((c) => (c[2] as Record<string, string> | undefined)?.pageToken)).toEqual([
      undefined,
      't1',
      't2',
    ])
    const lines = DEC.decode(result[0] as Uint8Array)
      .trimEnd()
      .split('\n')
    expect(lines.map((l) => (JSON.parse(l) as { files: { id: string }[] }).files[0]?.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('multi-page output is newline-terminated NDJSON', async () => {
    vi.mocked(client.googleGet)
      .mockReset()
      .mockResolvedValueOnce({ files: [], nextPageToken: 't1' })
      .mockResolvedValueOnce({ files: [] })
    const result = await runGwsMethod(method('drive.files.list'), makeInv(CONFIG, {}))
    if (result === null) throw new Error('expected result')
    expect(DEC.decode(result[0] as Uint8Array)).toBe(
      '{"files":[],"nextPageToken":"t1"}\n{"files":[]}\n',
    )
  })

  it('single-page output has no trailing newline', async () => {
    vi.mocked(client.googleGet).mockReset().mockResolvedValue({ files: [] })
    const result = await runGwsMethod(method('drive.files.list'), makeInv(CONFIG, {}))
    if (result === null) throw new Error('expected result')
    expect(DEC.decode(result[0] as Uint8Array)).toBe('{"files":[]}')
  })

  it('--page-limit stops early', async () => {
    vi.mocked(client.googleGet)
      .mockReset()
      .mockResolvedValueOnce({ files: [], nextPageToken: 't1' })
      .mockResolvedValueOnce({ files: [], nextPageToken: 't2' })
      .mockResolvedValueOnce({ files: [] })
    const result = await runGwsMethod(
      method('drive.files.list'),
      makeInv(CONFIG, { page_limit: '2' }),
    )
    if (result === null) throw new Error('expected result')
    expect(vi.mocked(client.googleGet).mock.calls.length).toBe(2)
    expect(
      DEC.decode(result[0] as Uint8Array)
        .trimEnd()
        .split('\n').length,
    ).toBe(2)
  })

  // Non-ASCII digits are rejected too, so the flag accepts exactly what
  // Python's isascii() + isdigit() accepts.
  it.each(['x', '-1', '1.5', '١٢', '²'])('rejects --page-limit %s', async (raw) => {
    const result = await runGwsMethod(
      method('drive.files.list'),
      makeInv(CONFIG, { page_limit: raw }),
    )
    if (result === null) throw new Error('expected result')
    expect(result[1].exitCode).toBe(2)
  })

  it('files delete outputs nothing', async () => {
    vi.mocked(client.googleDelete).mockResolvedValue(undefined)
    const result = await runGwsMethod(
      method('drive.files.delete'),
      makeInv(CONFIG, { params: '{"fileId": "f1"}' }),
    )
    if (result === null) throw new Error('expected result')
    expect(result[0]).toBeNull()
    expect(result[1].exitCode).toBe(0)
  })

  it('files create requires a body', async () => {
    const result = await runGwsMethod(method('drive.files.create'), makeInv(CONFIG, {}))
    if (result === null) throw new Error('expected result')
    expect(result[1].exitCode).toBe(2)
  })

  it('malformed --json is a usage error with the shared wording', async () => {
    const result = await runGwsMethod(
      method('drive.files.create'),
      makeInv(CONFIG, { json: '{not json' }),
    )
    if (result === null) throw new Error('expected result')
    expect(result[1].exitCode).toBe(2)
    expect(DEC.decode(result[1].stderr as Uint8Array)).toBe('--json must be valid JSON\n')
  })

  it('permissions create posts the body', async () => {
    vi.mocked(client.googlePost).mockResolvedValue({ id: 'p1' })
    const result = await runGwsMethod(
      method('drive.permissions.create'),
      makeInv(CONFIG, { params: '{"fileId": "f1"}', json: '{"role": "reader", "type": "anyone"}' }),
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
      makeInv(CONFIG, { params: '{"fileId": "f1", "mimeType": "application/pdf"}' }),
    )
    if (result === null) throw new Error('expected result')
    expect(DEC.decode(result[0] as Uint8Array)).toBe('%PDF-1.4')
    const url = vi.mocked(client.googleGetBytes).mock.calls.at(-1)?.[1]
    expect(url).toContain('/files/f1/export?mimeType=application/pdf')
  })
})

describe('gws folder scope placement', () => {
  const SCOPED: GoogleConfig = { clientId: 'cid', refreshToken: 'rt', folderId: 'F1' }

  it('declares shared drive support alongside an injected parent', async () => {
    vi.mocked(client.googlePost).mockReset().mockResolvedValue({ id: 'f9' })
    await runGwsMethod(method('drive.files.create'), makeInv(SCOPED, { json: '{"name": "n"}' }))
    const call = vi.mocked(client.googlePost).mock.calls.at(-1)
    expect(call?.[2]).toEqual({ name: 'n', parents: ['F1'] })
    expect(call?.[1]).toContain('supportsAllDrives=true')
  })

  it('leaves an explicit parents array a passthrough', async () => {
    vi.mocked(client.googlePost).mockReset().mockResolvedValue({ id: 'f9' })
    await runGwsMethod(
      method('drive.files.create'),
      makeInv(SCOPED, { json: '{"name": "n", "parents": ["OTHER"]}' }),
    )
    const call = vi.mocked(client.googlePost).mock.calls.at(-1)
    expect(call?.[2]).toEqual({ name: 'n', parents: ['OTHER'] })
    expect(call?.[1]).not.toContain('supportsAllDrives')
  })

  it('declares shared drive support on the relocation patch', async () => {
    vi.mocked(client.googlePost).mockReset().mockResolvedValue({ spreadsheetId: 's1' })
    vi.mocked(client.googlePatch).mockReset().mockResolvedValue({ id: 's1' })
    await runGwsMethod(
      method('sheets.spreadsheets.create'),
      makeInv(SCOPED, { json: '{"properties": {"title": "T"}}' }),
    )
    expect(vi.mocked(client.googlePatch).mock.calls.at(-1)?.[3]).toEqual({
      addParents: 'F1',
      removeParents: 'root',
      supportsAllDrives: 'true',
    })
  })

  it("treats an explicitly empty parents array as the caller's", async () => {
    vi.mocked(client.googlePost).mockReset().mockResolvedValue({ id: 'f9' })
    await runGwsMethod(
      method('drive.files.create'),
      makeInv(SCOPED, { json: '{"name": "n", "parents": []}' }),
    )
    const call = vi.mocked(client.googlePost).mock.calls.at(-1)
    expect(call?.[2]).toEqual({ name: 'n', parents: [] })
    expect(call?.[1]).not.toContain('supportsAllDrives')
  })

  it('places nothing for an unscoped install', async () => {
    vi.mocked(client.googlePost).mockReset().mockResolvedValue({ spreadsheetId: 's1' })
    vi.mocked(client.googlePatch).mockReset()
    await runGwsMethod(
      method('sheets.spreadsheets.create'),
      makeInv(CONFIG, { json: '{"properties": {"title": "T"}}' }),
    )
    expect(vi.mocked(client.googlePatch).mock.calls.length).toBe(0)
  })
})
