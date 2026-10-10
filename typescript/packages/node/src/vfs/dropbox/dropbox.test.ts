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
import { InlineDropbox } from '../fixtures/dropbox.ts'
import { buildVfs } from '../registry.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

let dbx: InlineDropbox
let ws: Workspace

async function workspace(): Promise<Workspace> {
  const vfs = await buildVfs('dropbox', {
    client_id: 'c',
    client_secret: 's',
    refresh_token: 'r',
    endpoint: dbx.url,
  })
  return new Workspace({ '/dbx': new Mount(vfs, { mode: MountMode.WRITE }) })
}

beforeEach(async () => {
  dbx = new InlineDropbox({ f: ENC.encode('one\n') })
  vi.stubGlobal('fetch', dbx.fetch)
  ws = await workspace()
})

afterEach(async () => {
  await ws.close()
  vi.unstubAllGlobals()
})

describe('dropbox listing miss', () => {
  it.each([
    ['append', 'cat /dbx/f >> /dbx/n', 'v1\none\n'],
    ['touch', 'touch /dbx/n', 'v1\n'],
    ['sed-i', 'sed -i s/v1/v2/ /dbx/n', 'v2\n'],
    ['group-append', '{ echo x; } >> /dbx/n', 'v1\nx\n'],
  ])('finds a file created after the listing (%s)', async (_id, line, after) => {
    await ws.shell('ls /dbx')
    dbx.write('n', ENC.encode('v1\n'))
    const r = await ws.shell(line)
    expect([r.exitCode, DEC.decode(r.stderr)]).toEqual([0, ''])
    expect(DEC.decode(dbx.read('n'))).toBe(after)
  })

  // A listing this command fetched, cold, for its own glob or re-listed
  // after its own write, is live evidence of absence; one an earlier line
  // left behind is not, and the miss asks once by path.
  it.each([
    ['cold', '', 'cat /dbx/missing', 1, ['list_folder']],
    ['glob-in-this-command', '', 'cat /dbx/f* /dbx/missing', 1, ['list_folder', 'download']],
    ['earlier-line', 'ls /dbx', 'cat /dbx/missing', 1, ['get_metadata']],
    [
      'bulk-create',
      '',
      'touch /dbx/a /dbx/b /dbx/c',
      0,
      ['list_folder', 'upload', 'list_folder', 'upload', 'list_folder', 'upload', 'list_folder'],
    ],
    [
      'glob-then-append',
      '',
      'echo /dbx/* >> /dbx/new',
      0,
      ['list_folder', 'upload', 'list_folder', 'download', 'upload'],
    ],
  ])('asks Dropbox only past an earlier listing (%s)', async (_id, setup, line, code, routes) => {
    if (setup !== '') await ws.shell(setup)
    const start = dbx.log.length
    const r = await ws.shell(line)
    expect(r.exitCode).toBe(code)
    expect(dbx.log.slice(start).filter((route) => route !== 'token')).toEqual(routes)
  })

  // FUSE and programmatic calls belong to no command, so no listing is
  // theirs to trust, however recent.
  it('asks Dropbox for every miss outside a command', async () => {
    await ws.shell('ls /dbx')
    const start = dbx.log.length
    await expect(ws.vfs.stat('/dbx/.DS_Store')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(dbx.log.slice(start).filter((route) => route !== 'token')).toEqual(['get_metadata'])
  })
})
