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

import { GSheetsAccessor } from '../../accessor/gsheets.ts'
import { PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/_client.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../../resource/base.ts'
import { walkFind } from '../generic/find.ts'
import { isDirName } from './readdir.ts'
import * as readdirMod from './readdir.ts'
import * as statMod from './stat.ts'

async function find(
  accessor: GSheetsAccessor,
  path: PathSpec,
  options: FindOptions = {},
  index?: IndexCacheStore,
): Promise<string[]> {
  return walkFind(
    path,
    {
      readdir: (spec, idx) => readdirMod.readdir(accessor, spec, idx),
      stat: (spec, idx) => statMod.stat(accessor, spec, idx),
      isDirName: (child) => isDirName(child),
    },
    options,
    index,
  )
}

const STUB_TM = {} as TokenManager

function makeAccessor(): GSheetsAccessor {
  return new GSheetsAccessor({ tokenManager: STUB_TM })
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
  '/': ['/owned', '/shared'],
  '/owned': ['/owned/Sheet_A__s1.gsheet.json'],
  '/shared': [],
}

const ROOT = new PathSpec({ resourcePath: '', virtual: '/', directory: '/' })

describe('gsheets core find', () => {
  beforeEach(() => {
    vi.mocked(readdirMod.readdir).mockReset()
    vi.mocked(statMod.stat).mockReset()
    // walkFind stats the start path to decide whether to emit it; no
    // fixture entry for '/' keeps these walks root-less.
    vi.mocked(statMod.stat).mockImplementation((_accessor, spec) =>
      Promise.reject(enoent(spec.virtual)),
    )
    mockTree(TREE)
  })

  it('classifies .gsheet.json entries as files and the rest as dirs without stat', async () => {
    const files = await find(makeAccessor(), ROOT, { type: 'f' })
    expect(files).toEqual(['/owned/Sheet_A__s1.gsheet.json'])
    const dirs = await find(makeAccessor(), ROOT, { type: 'd' })
    expect(dirs).toEqual(['/owned', '/shared'])
    const statted = vi.mocked(statMod.stat).mock.calls.map((c) => c[1].virtual)
    expect([...new Set(statted)]).toEqual(['/'])
  })

  it('matches names with globs', async () => {
    const out = await find(makeAccessor(), ROOT, { name: '*.gsheet.json' })
    expect(out).toEqual(['/owned/Sheet_A__s1.gsheet.json'])
  })
})
