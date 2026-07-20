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

// Mirror of python/tests/commands/builtin/dropbox/test_narrow.py.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GenericBindModule from '../generic_bind/index.ts'

const { resolveGlobSpy } = vi.hoisted(() => ({ resolveGlobSpy: vi.fn() }))

vi.mock('../generic_bind/index.ts', async () => {
  const actual = await vi.importActual<typeof GenericBindModule>('../generic_bind/index.ts')
  return { ...actual, resolveGlobOf: () => resolveGlobSpy }
})

vi.mock('../../../core/dropbox/search.ts', () => ({ narrowPaths: vi.fn() }))
vi.mock('../../../core/dropbox/stat.ts', () => ({ stat: vi.fn() }))

import { DropboxAccessor } from '../../../accessor/dropbox.ts'
import type { DropboxTokenManager } from '../../../core/dropbox/_client.ts'
import * as searchModule from '../../../core/dropbox/search.ts'
import * as statModule from '../../../core/dropbox/stat.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { narrowScope } from './narrow.ts'

const STUB_TM = {} as DropboxTokenManager
const narrow = vi.mocked(searchModule.narrowPaths)
const stat = vi.mocked(statModule.stat)

const DIR_STAT = new FileStat({ name: 'data', type: FileType.DIRECTORY })
const FILE_STAT = new FileStat({ name: 'x.txt', type: FileType.TEXT })

function makeAccessor(contentSearch = true): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: STUB_TM, contentSearch })
}

function scope(): PathSpec {
  return new PathSpec({ virtual: '/data', directory: '/data', resourcePath: '' })
}

function spec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: '',
    resourcePath: virtual.replace(/^\/data\//, ''),
    resolved: true,
  })
}

async function run(
  overrides: { pattern?: string | null; recursive?: boolean; exactFileSet?: boolean } = {},
  accessor = makeAccessor(),
): Promise<{ resolved: PathSpec[]; usedSearch: boolean }> {
  return narrowScope(accessor, [scope()], overrides.pattern ?? 'needle', {
    fixedString: false,
    recursive: overrides.recursive ?? true,
    exactFileSet: overrides.exactFileSet ?? false,
  })
}

beforeEach(() => {
  narrow.mockReset()
  stat.mockReset()
  resolveGlobSpy.mockReset()
  stat.mockResolvedValue(DIR_STAT)
  narrow.mockResolvedValue([spec('/data/a.txt')])
  resolveGlobSpy.mockResolvedValue([scope()])
})

describe('narrowScope', () => {
  it('narrows recursive literal scans', async () => {
    const out = await run()
    expect(out.usedSearch).toBe(true)
    expect(out.resolved.map((p) => p.virtual)).toEqual(['/data/a.txt'])
    expect(narrow).toHaveBeenCalledTimes(1)
    expect(resolveGlobSpy).not.toHaveBeenCalled()
  })

  it('skips search when the knob is off', async () => {
    const out = await run({}, makeAccessor(false))
    expect(out.usedSearch).toBe(false)
    expect(narrow).not.toHaveBeenCalled()
    expect(resolveGlobSpy).toHaveBeenCalledTimes(1)
  })

  it('skips search for non-recursive scans', async () => {
    const out = await run({ recursive: false })
    expect(out.usedSearch).toBe(false)
    expect(narrow).not.toHaveBeenCalled()
  })

  it('skips search when the output needs the exact file set', async () => {
    const out = await run({ exactFileSet: true })
    expect(out.usedSearch).toBe(false)
    expect(narrow).not.toHaveBeenCalled()
  })

  it('skips search for multi-line pattern lists', async () => {
    const out = await run({ pattern: 'foo\nbar' })
    expect(out.usedSearch).toBe(false)
    expect(narrow).not.toHaveBeenCalled()
  })

  it('skips search for regexes without a required literal', async () => {
    const out = await run({ pattern: 'foo|bar' })
    expect(out.usedSearch).toBe(false)
    expect(narrow).not.toHaveBeenCalled()
  })

  it('narrows regexes on their required literal', async () => {
    const out = await run({ pattern: 'import.*os' })
    expect(out.usedSearch).toBe(true)
    expect(narrow.mock.calls[0]?.[1]).toBe('import')
  })

  it('skips search for file scopes', async () => {
    stat.mockResolvedValue(FILE_STAT)
    const out = await run()
    expect(out.usedSearch).toBe(false)
    expect(narrow).not.toHaveBeenCalled()
  })

  it('skips search for missing scopes', async () => {
    stat.mockRejectedValue(new Error('enoent'))
    const out = await run()
    expect(out.usedSearch).toBe(false)
    expect(narrow).not.toHaveBeenCalled()
  })

  it('falls back to glob when narrowing is unusable', async () => {
    narrow.mockResolvedValue(null)
    const out = await run()
    expect(out.usedSearch).toBe(false)
    expect(resolveGlobSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to glob for an empty narrow', async () => {
    narrow.mockResolvedValue([])
    const out = await run()
    expect(out.usedSearch).toBe(false)
    expect(resolveGlobSpy).toHaveBeenCalledTimes(1)
  })

  it('drops binary candidates', async () => {
    narrow.mockResolvedValue([spec('/data/a.parquet'), spec('/data/a.txt')])
    const out = await run()
    expect(out.usedSearch).toBe(true)
    expect(out.resolved.map((p) => p.virtual)).toEqual(['/data/a.txt'])
  })

  it('keeps usedSearch for an all-binary narrow', async () => {
    narrow.mockResolvedValue([spec('/data/a.parquet')])
    const out = await run()
    expect(out.usedSearch).toBe(true)
    expect(out.resolved).toEqual([])
    expect(resolveGlobSpy).not.toHaveBeenCalled()
  })
})
