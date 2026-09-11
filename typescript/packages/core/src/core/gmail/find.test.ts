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
import type * as ReaddirModule from './readdir.ts'
import type * as StatModule from './stat.ts'

vi.mock('./readdir.ts', async () => {
  const actual = await vi.importActual<typeof ReaddirModule>('./readdir.ts')
  return { ...actual, readdir: vi.fn() }
})

vi.mock('./stat.ts', async () => {
  const actual = await vi.importActual<typeof StatModule>('./stat.ts')
  return { ...actual, stat: vi.fn() }
})

import { GmailAccessor } from '../../accessor/gmail.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/client.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../../resource/base.ts'
import { walkFind } from '../generic/find.ts'
import * as readdirMod from './readdir.ts'
import * as statMod from './stat.ts'

async function find(
  accessor: GmailAccessor,
  path: PathSpec,
  options: FindOptions = {},
  index?: IndexCacheStore,
): Promise<string[]> {
  return walkFind(
    path,
    {
      readdir: (spec, idx) => readdirMod.readdir(accessor, spec, idx),
      stat: (spec, idx) => statMod.stat(accessor, spec, idx),
    },
    options,
    index,
  )
}

const STUB_TM = {} as TokenManager

function makeAccessor(): GmailAccessor {
  return new GmailAccessor({ tokenManager: STUB_TM })
}

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

function mockTree(tree: Record<string, string[]>): void {
  vi.mocked(readdirMod.readdir).mockImplementation((_accessor, spec) => {
    const children = tree[spec.virtual]
    if (children === undefined) return Promise.reject(enoent(spec.virtual))
    return Promise.resolve(children)
  })
}

const TREE: Record<string, string[]> = {
  '/': ['/INBOX'],
  '/INBOX': ['/INBOX/2026-06-01'],
  '/INBOX/2026-06-01': ['/INBOX/2026-06-01/Hello__m1.gmail.json', '/INBOX/2026-06-01/Hello__m1'],
  '/INBOX/2026-06-01/Hello__m1': ['/INBOX/2026-06-01/Hello__m1/report.pdf'],
}

const DIRS = new Set(['/INBOX', '/INBOX/2026-06-01', '/INBOX/2026-06-01/Hello__m1'])

const ROOT = new PathSpec({ resourcePath: '', virtual: '/', directory: '/' })

describe('gmail core find', () => {
  beforeEach(() => {
    vi.mocked(readdirMod.readdir).mockReset()
    vi.mocked(statMod.stat).mockReset()
    // walkFind stats the start path to decide whether to emit it; no
    // fixture entry for '/' keeps these walks root-less. Children classify
    // through stat, which is what lets an attachment named report.pdf be a
    // file while its like-named parent dir stays a directory.
    vi.mocked(statMod.stat).mockImplementation((_accessor, spec) => {
      if (DIRS.has(spec.virtual)) {
        const name = spec.virtual.split('/').pop() ?? ''
        return Promise.resolve(new FileStat({ name, type: FileType.DIRECTORY }))
      }
      if (spec.virtual === '/INBOX/2026-06-01/Hello__m1/report.pdf') {
        return Promise.resolve(
          new FileStat({
            name: 'report.pdf',
            size: 3,
            type: FileType.FILE,
            content: ContentType.PDF,
          }),
        )
      }
      if (spec.virtual === '/INBOX/2026-06-01/Hello__m1.gmail.json') {
        return Promise.resolve(
          new FileStat({
            name: 'Hello__m1.gmail.json',
            size: 5,
            type: FileType.FILE,
            content: ContentType.JSON,
          }),
        )
      }
      return Promise.reject(enoent(spec.virtual))
    })
    mockTree(TREE)
  })

  it('classifies messages and attachments as files, attachment dirs as dirs', async () => {
    const files = await find(makeAccessor(), ROOT, { type: 'f' })
    expect(files).toEqual([
      '/INBOX/2026-06-01/Hello__m1.gmail.json',
      '/INBOX/2026-06-01/Hello__m1/report.pdf',
    ])
    const dirs = await find(makeAccessor(), ROOT, { type: 'd' })
    expect(dirs).toEqual(['/INBOX', '/INBOX/2026-06-01', '/INBOX/2026-06-01/Hello__m1'])
  })

  it('matches message names with globs', async () => {
    const out = await find(makeAccessor(), ROOT, { name: '*.gmail.json' })
    expect(out).toEqual(['/INBOX/2026-06-01/Hello__m1.gmail.json'])
  })

  it('honors GNU depth bounds across the label/date hierarchy', async () => {
    expect(await find(makeAccessor(), ROOT, { maxDepth: 0 })).toEqual([])
    expect(await find(makeAccessor(), ROOT, { maxDepth: 2 })).toEqual([
      '/INBOX',
      '/INBOX/2026-06-01',
    ])
    expect(await find(makeAccessor(), ROOT, { minDepth: 3 })).toEqual([
      '/INBOX/2026-06-01/Hello__m1',
      '/INBOX/2026-06-01/Hello__m1.gmail.json',
      '/INBOX/2026-06-01/Hello__m1/report.pdf',
    ])
  })
})
