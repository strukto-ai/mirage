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

import { stripSlash } from '../../utils/slash.ts'
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
import { PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/_client.ts'
import { find } from './find.ts'
import * as readdirMod from './readdir.ts'
import * as statMod from './stat.ts'

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
  '/INBOX/2026-06-01': ['/INBOX/2026-06-01/Hello__m1.gmail.json'],
}

const ROOT = new PathSpec({ resourcePath: stripSlash('/'), virtual: '/', directory: '/' })

describe('gmail core find', () => {
  beforeEach(() => {
    vi.mocked(readdirMod.readdir).mockReset()
    vi.mocked(statMod.stat).mockReset()
    mockTree(TREE)
  })

  it('classifies .gmail.json entries as files and label/date dirs without stat', async () => {
    const files = await find(makeAccessor(), ROOT, { type: 'f' })
    expect(files).toEqual(['/INBOX/2026-06-01/Hello__m1.gmail.json'])
    const dirs = await find(makeAccessor(), ROOT, { type: 'd' })
    expect(dirs).toEqual(['/INBOX', '/INBOX/2026-06-01'])
    expect(vi.mocked(statMod.stat)).not.toHaveBeenCalled()
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
      '/INBOX/2026-06-01/Hello__m1.gmail.json',
    ])
  })
})
