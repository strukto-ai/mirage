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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReaddirModule from '../../../core/email/readdir.ts'
import type * as StatModule from '../../../core/email/stat.ts'

vi.mock('../../../core/email/readdir.ts', async () => {
  const actual = await vi.importActual<typeof ReaddirModule>('../../../core/email/readdir.ts')
  return { ...actual, readdir: vi.fn() }
})

vi.mock('../../../core/email/stat.ts', async () => {
  const actual = await vi.importActual<typeof StatModule>('../../../core/email/stat.ts')
  return { ...actual, stat: vi.fn() }
})

import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import { materialize } from '@struktoai/mirage-core/io/types'
import { ContentType, FileStat, FileType, PathSpec } from '@struktoai/mirage-core/types'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import type { EmailAccessor } from '../../../accessor/email.ts'
import * as readdirMod from '../../../core/email/readdir.ts'
import * as statMod from '../../../core/email/stat.ts'
import { EMAIL_COMMANDS } from './index.ts'

const DEC = new TextDecoder()

const MSG = '/INBOX/2026-01-05/Report__7.email.json'
const ATT_DIR = '/INBOX/2026-01-05/Report__7'
const ATT = '/INBOX/2026-01-05/Report__7/invoice.pdf'

const TREE: Record<string, string[]> = {
  '/': ['/INBOX'],
  '/INBOX': ['/INBOX/2026-01-05'],
  '/INBOX/2026-01-05': [MSG, ATT_DIR],
  [ATT_DIR]: [ATT],
}

const DIRS = new Set(['/', '/INBOX', '/INBOX/2026-01-05', ATT_DIR])

function spec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: stripSlash(virtual),
  })
}

async function runFind(
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]>,
): Promise<string[]> {
  const cmd = EMAIL_COMMANDS.find((c) => c.name === 'find')
  if (cmd === undefined) throw new Error('find not registered')
  const result = await cmd.fn({} as EmailAccessor, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    index: new RAMIndexCacheStore(),
  })
  if (result === null) return []
  const [out] = result
  if (out === null) return []
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf).split('\n').filter(Boolean)
}

describe('email find', () => {
  beforeEach(() => {
    vi.mocked(readdirMod.readdir).mockReset()
    vi.mocked(statMod.stat).mockReset()
    vi.mocked(readdirMod.readdir).mockImplementation((_accessor, p) => {
      const children = TREE[p.virtual]
      if (children === undefined) {
        const e = new Error(`ENOENT: ${p.virtual}`) as Error & { code: string }
        e.code = 'ENOENT'
        return Promise.reject(e)
      }
      return Promise.resolve(children)
    })
    vi.mocked(statMod.stat).mockImplementation((_accessor, p) => {
      const name = p.virtual.split('/').pop() ?? '/'
      if (DIRS.has(p.virtual))
        return Promise.resolve(new FileStat({ name, type: FileType.DIRECTORY }))
      if (p.virtual === MSG)
        return Promise.resolve(
          new FileStat({ name, size: 5, type: FileType.FILE, content: ContentType.JSON }),
        )
      if (p.virtual === ATT)
        return Promise.resolve(
          new FileStat({ name, size: 3, type: FileType.FILE, content: ContentType.PDF }),
        )
      const e = new Error(`ENOENT: ${p.virtual}`) as Error & { code: string }
      e.code = 'ENOENT'
      return Promise.reject(e)
    })
  })

  it('lists messages and attachments under -type f, not dirs', async () => {
    const lines = await runFind([spec('/')], { type: 'f' })
    expect(lines).toContain(MSG)
    expect(lines).toContain(ATT)
    expect(lines).not.toContain(ATT_DIR)
    expect(lines).not.toContain('/INBOX')
  })

  it('lists the attachment dir under -type d, not the attachment', async () => {
    const lines = await runFind([spec('/')], { type: 'd' })
    expect(lines).toContain(ATT_DIR)
    expect(lines).not.toContain(ATT)
    expect(lines).not.toContain(MSG)
  })

  it('still matches names with globs', async () => {
    const lines = await runFind([spec('/')], { name: '*.email.json' })
    expect(lines).toEqual([MSG])
  })
})
