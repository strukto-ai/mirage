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

import { describe, expect, it } from 'vitest'
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import type { FindOptions } from '../generic/find.ts'
import { walkFind } from '../generic/find.ts'

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

const TREE: Record<string, string[]> = {
  '/': ['/INBOX'],
  '/INBOX': ['/INBOX/2026-06-01'],
  '/INBOX/2026-06-01': ['/INBOX/2026-06-01/Hello__m1.gmail.json', '/INBOX/2026-06-01/Hello__m1'],
  '/INBOX/2026-06-01/Hello__m1': ['/INBOX/2026-06-01/Hello__m1/report.pdf'],
}

const DIRS = new Set(['/INBOX', '/INBOX/2026-06-01', '/INBOX/2026-06-01/Hello__m1'])

const ROOT = new PathSpec({ vfsPath: '', virtual: '/', directory: '/' })

function readdirOf(spec: PathSpec): Promise<string[]> {
  const children = TREE[spec.virtual]
  if (children === undefined) return Promise.reject(enoent(spec.virtual))
  return Promise.resolve(children)
}

// walkFind stats the start path to decide whether to emit it; no fixture
// entry for '/' keeps these walks root-less. Children classify through stat,
// which is what lets an attachment named report.pdf be a file while its
// like-named parent dir stays a directory.
function statOf(spec: PathSpec): Promise<FileStat> {
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
}

async function find(path: PathSpec, options: FindOptions = {}): Promise<string[]> {
  return walkFind(path, { readdir: readdirOf, stat: statOf }, options)
}

describe('gmail core find', () => {
  it('classifies messages and attachments as files, attachment dirs as dirs', async () => {
    const files = await find(ROOT, { type: 'f' })
    expect(files).toEqual([
      '/INBOX/2026-06-01/Hello__m1.gmail.json',
      '/INBOX/2026-06-01/Hello__m1/report.pdf',
    ])
    const dirs = await find(ROOT, { type: 'd' })
    expect(dirs).toEqual(['/INBOX', '/INBOX/2026-06-01', '/INBOX/2026-06-01/Hello__m1'])
  })

  it('matches message names with globs', async () => {
    const out = await find(ROOT, { name: '*.gmail.json' })
    expect(out).toEqual(['/INBOX/2026-06-01/Hello__m1.gmail.json'])
  })

  it('honors GNU depth bounds across the label/date hierarchy', async () => {
    expect(await find(ROOT, { maxDepth: 0 })).toEqual([])
    expect(await find(ROOT, { maxDepth: 2 })).toEqual(['/INBOX', '/INBOX/2026-06-01'])
    expect(await find(ROOT, { minDepth: 3 })).toEqual([
      '/INBOX/2026-06-01/Hello__m1',
      '/INBOX/2026-06-01/Hello__m1.gmail.json',
      '/INBOX/2026-06-01/Hello__m1/report.pdf',
    ])
  })
})
