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
import type * as DriveModule from '../../../core/google/drive.ts'

vi.mock('../../../core/google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../../../core/google/drive.ts')
  return {
    ...actual,
    downloadFile: vi.fn(),
    listFiles: vi.fn(() => Promise.resolve([])),
    listSharedDrives: vi.fn(() => Promise.resolve([])),
    updateFileContent: vi.fn(),
  }
})

import { GDriveAccessor } from '../../../accessor/gdrive.ts'
import { IndexEntry } from '../../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import type { TokenManager } from '../../../core/google/_client.ts'
import * as drive from '../../../core/google/drive.ts'
import { materialize } from '../../../io/types.ts'
import type { Resource } from '../../../resource/base.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { GDRIVE_COMMANDS } from './index.ts'

const GDRIVE_SED = GDRIVE_COMMANDS.filter((c) => c.name === 'sed' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function makeAccessor(): GDriveAccessor {
  return new GDriveAccessor({
    tokenManager: { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager,
  })
}

function makeOpts(partial: Partial<CommandOpts>): CommandOpts {
  return {
    stdin: null,
    flags: {},
    filetypeFns: null,
    cwd: '/',
    resource: {} as Resource,
    ...partial,
  }
}

async function putFile(index: RAMIndexCacheStore, key: string, name: string): Promise<void> {
  await index.put(
    key,
    new IndexEntry({
      id: 'file123',
      name,
      resourceType: 'gdrive/file',
      remoteTime: '2026-01-01T00:00:00Z',
      vfsName: name,
      size: 100,
    }),
  )
}

async function outText(result: CommandFnResult): Promise<string> {
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out)
  return DEC.decode(buf)
}

describe('gdrive sed', () => {
  it('simple substitution on an indexed file', async () => {
    vi.mocked(drive.downloadFile).mockResolvedValue(ENC.encode('hello world\nhello again\n'))
    const index = new RAMIndexCacheStore()
    await putFile(index, '/test/file.txt', 'file.txt')
    const cmd = GDRIVE_SED[0]
    if (cmd === undefined) throw new Error('sed not registered')
    const result = await cmd.fn(
      makeAccessor() as never,
      [
        new PathSpec({
          resourcePath: 'test/file.txt',
          virtual: '/test/file.txt',
          directory: '/test',
        }),
      ],
      ['s/hello/bye/g'],
      makeOpts({ index }),
    )
    expect(await outText(result)).toBe('bye world\nbye again\n')
  })

  it('-n with print program', async () => {
    vi.mocked(drive.downloadFile).mockResolvedValue(ENC.encode('one\ntwo\nthree\n'))
    const index = new RAMIndexCacheStore()
    await putFile(index, '/test/file.txt', 'file.txt')
    const cmd = GDRIVE_SED[0]
    if (cmd === undefined) throw new Error('sed not registered')
    const result = await cmd.fn(
      makeAccessor() as never,
      [
        new PathSpec({
          resourcePath: 'test/file.txt',
          virtual: '/test/file.txt',
          directory: '/test',
        }),
      ],
      ['2p'],
      makeOpts({ flags: { n: true }, index }),
    )
    expect(await outText(result)).toBe('two\n')
  })

  it('reads stdin when no paths', async () => {
    const cmd = GDRIVE_SED[0]
    if (cmd === undefined) throw new Error('sed not registered')
    const result = await cmd.fn(
      makeAccessor() as never,
      [],
      ['s/a/b/g'],
      makeOpts({ stdin: ENC.encode('banana\n') }),
    )
    expect(await outText(result)).toBe('bbnbnb\n')
  })

  it('-i writes the edit back through the Drive resolver', async () => {
    const index = new RAMIndexCacheStore()
    await putFile(index, '/test/file.txt', 'file.txt')
    vi.mocked(drive.downloadFile).mockResolvedValue(ENC.encode('hello world\n'))
    vi.mocked(drive.listFiles).mockImplementation((_tm, opts = {}) => {
      if (opts.name === 'test') {
        return Promise.resolve([{ id: 'dir1', name: 'test', mimeType: drive.FOLDER_MIME }])
      }
      if (opts.name === 'file.txt') {
        return Promise.resolve([{ id: 'file123', name: 'file.txt', mimeType: 'text/plain' }])
      }
      return Promise.resolve([])
    })
    const update = vi
      .mocked(drive.updateFileContent)
      .mockResolvedValue({ id: 'file123', name: 'file.txt' })
    const cmd = GDRIVE_SED[0]
    if (cmd === undefined) throw new Error('sed not registered')
    const result = await cmd.fn(
      makeAccessor() as never,
      [
        new PathSpec({
          resourcePath: 'test/file.txt',
          virtual: '/test/file.txt',
          directory: '/test',
        }),
      ],
      ['s/hello/bye/'],
      makeOpts({ flags: { i: true }, index }),
    )
    if (result === null) throw new Error('expected a result')
    const [, io] = result
    expect(io.exitCode).toBe(0)
    expect(update).toHaveBeenCalledTimes(1)
    const call = update.mock.calls[0]
    if (call === undefined) throw new Error('expected an update call')
    expect(call[1]).toBe('file123')
    expect(DEC.decode(call[2])).toBe('bye world\n')
  })
})
