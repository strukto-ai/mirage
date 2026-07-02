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
  return { ...actual, downloadFile: vi.fn() }
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

const GDRIVE_CUT = GDRIVE_COMMANDS.filter((c) => c.name === 'cut' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function makeAccessor(): GDriveAccessor {
  return new GDriveAccessor({ tokenManager: {} as TokenManager })
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

async function outText(result: CommandFnResult): Promise<string> {
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out)
  return DEC.decode(buf)
}

describe('gdrive cut', () => {
  it('-f with -d on an indexed file', async () => {
    vi.mocked(drive.downloadFile).mockResolvedValue(ENC.encode('a,b,c\n1,2,3\n'))
    const index = new RAMIndexCacheStore()
    await index.put(
      '/test/file.csv',
      new IndexEntry({
        id: 'file123',
        name: 'file.csv',
        resourceType: 'gdrive/file',
        remoteTime: '2026-01-01T00:00:00Z',
        vfsName: 'file.csv',
        size: 100,
      }),
    )
    const cmd = GDRIVE_CUT[0]
    if (cmd === undefined) throw new Error('cut not registered')
    const result = await cmd.fn(
      makeAccessor() as never,
      [
        new PathSpec({
          resourcePath: 'test/file.csv',
          virtual: '/test/file.csv',
          directory: '/test',
        }),
      ],
      [],
      makeOpts({ flags: { d: ',', f: '2' }, index }),
    )
    expect(await outText(result)).toBe('b\n2\n')
  })

  it('-c char range on an indexed file', async () => {
    vi.mocked(drive.downloadFile).mockResolvedValue(ENC.encode('hello\nworld\n'))
    const index = new RAMIndexCacheStore()
    await index.put(
      '/test/file.txt',
      new IndexEntry({
        id: 'file456',
        name: 'file.txt',
        resourceType: 'gdrive/file',
        remoteTime: '2026-01-01T00:00:00Z',
        vfsName: 'file.txt',
        size: 100,
      }),
    )
    const cmd = GDRIVE_CUT[0]
    if (cmd === undefined) throw new Error('cut not registered')
    const result = await cmd.fn(
      makeAccessor() as never,
      [
        new PathSpec({
          resourcePath: 'test/file.txt',
          virtual: '/test/file.txt',
          directory: '/test',
        }),
      ],
      [],
      makeOpts({ flags: { c: '1-3' }, index }),
    )
    expect(await outText(result)).toBe('hel\nwor\n')
  })

  it('reads stdin when no paths', async () => {
    const cmd = GDRIVE_CUT[0]
    if (cmd === undefined) throw new Error('cut not registered')
    const result = await cmd.fn(
      makeAccessor() as never,
      [],
      [],
      makeOpts({ stdin: ENC.encode('x:y:z\n'), flags: { d: ':', f: '1,3' } }),
    )
    expect(await outText(result)).toBe('x:z\n')
  })
})
