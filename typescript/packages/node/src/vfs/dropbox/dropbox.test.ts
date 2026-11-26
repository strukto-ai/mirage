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

import { MountMode } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { DropboxAccount, TOKEN } from '../../../tests/vfs/fixtures/dropbox.ts'
import { buildVfs } from '../registry.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const WRITES = ['upload', 'delete_v2', 'move_v2', 'copy_v2', 'create_folder_v2']

let dbx: DropboxAccount
let ws: Workspace

async function workspace(): Promise<Workspace> {
  const vfs = await buildVfs('dropbox', {
    client_id: 'c',
    client_secret: 's',
    refresh_token: TOKEN,
    endpoint: dbx.run.url,
  })
  return new Workspace({ '/dbx': new Mount(vfs, { mode: MountMode.WRITE }) })
}

/** Each request's endpoint name, the token refresh left out. */
function endpoints(requests: string[]): string[] {
  return requests
    .map((request) => request.slice(request.lastIndexOf('/') + 1))
    .filter((name) => name !== 'token')
}

async function text(path: string): Promise<string> {
  return DEC.decode(await dbx.content(path))
}

function folded(value: unknown): unknown {
  return typeof value === 'string' && value.startsWith('/') ? value.toLowerCase() : value
}

beforeEach(async () => {
  dbx = new DropboxAccount(await serve('dropbox'))
  await dbx.put('/f', ENC.encode('one\n'))
  await dbx.run.recordRequests()
  ws = await workspace()
})

// The run is closed even when the workspace was never made or fails to close.
afterEach(async () => {
  try {
    await ws.close()
  } finally {
    vi.unstubAllGlobals()
    await dbx.run.close()
  }
})

describe('dropbox listing miss', () => {
  // >>, sed -i and truncate on a simple command are integ's
  // write_conditional_own_read_ops_need_no_prior_read.
  it.each([
    ['touch', 'touch /dbx/n', 'v1\n'],
    ['group-append', '{ echo x; } >> /dbx/n', 'v1\nx\n'],
  ])('finds a file created after the listing (%s)', async (_id, line, after) => {
    await ws.shell('ls /dbx')
    await dbx.put('/n', ENC.encode('v1\n'))
    const r = await ws.shell(line)
    expect([r.exitCode, DEC.decode(r.stderr)]).toEqual([0, ''])
    expect(await text('/n')).toBe(after)
  })

  // With no listing stored a miss asks by path, and cat's directory probe
  // lists the parent. A listing this command fetched for its own glob is live
  // evidence of absence; one an earlier line left behind is not, and the miss
  // asks once by path.
  it.each([
    ['cold', '', 'cat /dbx/missing', 1, ['get_metadata', 'list_folder']],
    [
      'glob-in-this-command',
      '',
      'cat /dbx/f* /dbx/missing',
      1,
      ['list_folder', 'get_metadata', 'download'],
    ],
    ['earlier-line', 'ls /dbx', 'cat /dbx/missing', 1, ['get_metadata']],
    [
      'bulk-create',
      '',
      'touch /dbx/a /dbx/b /dbx/c',
      0,
      [
        'get_metadata',
        'get_metadata',
        'upload',
        'get_metadata',
        'get_metadata',
        'upload',
        'get_metadata',
        'get_metadata',
        'upload',
      ],
    ],
  ])('asks Dropbox only past an earlier listing (%s)', async (_id, setup, line, code, routes) => {
    if (setup !== '') await ws.shell(setup)
    await dbx.run.recordRequests()
    const r = await ws.shell(line)
    expect(r.exitCode).toBe(code)
    expect(endpoints(await dbx.run.requests())).toEqual(routes)
  })

  it('preserves the existing target and sibling when appending expanded paths', async () => {
    await dbx.put('/out', new Uint8Array())
    const r = await ws.shell('echo /dbx/* >> /dbx/out')
    expect([r.exitCode, DEC.decode(r.stderr)]).toEqual([0, ''])
    expect(await dbx.content('/out')).toEqual(ENC.encode('/dbx/f /dbx/out\n'))
    expect(await dbx.content('/f')).toEqual(ENC.encode('one\n'))
    expect(endpoints(await dbx.run.requests())).toEqual([
      'list_folder',
      'list_folder',
      'get_metadata',
      'download',
      'get_metadata',
      'upload',
    ])
  })

  // FUSE and programmatic calls belong to no command, so no listing is
  // theirs to trust, however recent.
  it('asks Dropbox for every miss outside a command', async () => {
    await ws.shell('ls /dbx')
    await dbx.run.recordRequests()
    await expect(ws.vfs.stat('/dbx/.DS_Store')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(endpoints(await dbx.run.requests())).toEqual(['get_metadata'])
  })
})

it('refuses hidden case aliases over a folding service', async () => {
  await dbx.put('/secret.txt', ENC.encode('secret'))
  await dbx.put('/vault/private.txt', ENC.encode('private'))
  // Dropbox matches a path in any case, and the fake matches it exactly: each
  // path a request names is lowercased on its way, and the fake's names are
  // lowercase already.
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    const headers = new Headers(request.headers)
    let bytes = new Uint8Array(await request.arrayBuffer())
    const arg = headers.get('Dropbox-API-Arg')
    if (arg !== null) {
      const parsed = JSON.parse(arg) as { path: string }
      parsed.path = folded(parsed.path) as string
      headers.set('Dropbox-API-Arg', JSON.stringify(parsed))
    } else if (!request.url.endsWith('/oauth2/token')) {
      const parsed = JSON.parse(DEC.decode(bytes)) as Record<string, unknown>
      for (const key of ['path', 'from_path', 'to_path']) parsed[key] = folded(parsed[key])
      bytes = ENC.encode(JSON.stringify(parsed))
    }
    return fetch(request.url, { method: request.method, headers, body: bytes })
  })
  expect((await ws.shell('cat /dbx/secret.txt /dbx/vault/private.txt')).exitCode).toBe(0)
  ws.createSession('hidden', { profile: { paths: { hide: ['/dbx/secret.txt', '/dbx/vault'] } } })
  await dbx.run.recordRequests()
  for (const command of [
    'cat /dbx/SECRET.txt',
    'cat /dbx/Vault/private.txt',
    'ls /dbx/Vault',
    'echo changed > /dbx/SECRET.txt',
    'echo changed > /dbx/Vault/new.txt',
    'cp /dbx/f /dbx/SECRET.txt',
    'mv /dbx/f /dbx/SECRET.txt',
  ]) {
    const result = await ws.shell(command, { sessionId: 'hidden' })
    expect(result.exitCode, command).not.toBe(0)
    expect(DEC.decode(result.stdout), command).not.toContain('secret')
  }
  const sent = endpoints(await dbx.run.requests())
  expect(await text('/secret.txt')).toBe('secret')
  expect(await text('/vault/private.txt')).toBe('private')
  expect(await text('/f')).toBe('one\n')
  expect(sent.filter((name) => WRITES.includes(name))).toEqual([])
})
