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

import {
  buildDirEntries,
  extractDocumentSize,
  extractSlug,
  normalizeSlug,
  scalarString,
  timestampToIso,
} from './tree.ts'

function doc(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    enabled: true,
    indexing_status: 'completed',
    archived: false,
    tokens: 8,
    data_source_type: 'upload_file',
    ...overrides,
  }
}

const QUICKSTART = doc({
  id: 'doc-quickstart',
  name: 'Quickstart',
  doc_metadata: [{ name: 'slug', value: 'guides/quickstart' }],
  data_source_detail_dict: { upload_file: { size: 180 } },
  created_at: 1716282000,
})

const CHANGELOG = doc({ id: 'doc-changelog', name: 'CHANGELOG.md', doc_metadata: [] })

function entryFor(
  entries: Map<
    string,
    [
      string,
      { name: string; resourceType: string; size: number | null; extra: Record<string, unknown> },
    ][]
  >,
  dir: string,
  name: string,
) {
  return (entries.get(dir) ?? []).find(([n]) => n === name)?.[1]
}

describe('normalizeSlug', () => {
  it('normalizes a relative slug to an absolute path', () => {
    expect(normalizeSlug('guides/quickstart')).toBe('/guides/quickstart')
    expect(normalizeSlug('/CHANGELOG.md/')).toBe('/CHANGELOG.md')
  })

  it('rejects empty and dot segments', () => {
    expect(() => normalizeSlug('')).toThrow('Invalid empty Dify document slug.')
    expect(() => normalizeSlug('a/../b')).toThrow('Invalid Dify document slug segment')
  })
})

describe('extractSlug', () => {
  it('reads the slug metadata field when present', () => {
    expect(extractSlug(QUICKSTART, 'slug')).toEqual(['guides/quickstart', true])
  })

  it('falls back to the document name without a slug', () => {
    expect(extractSlug(CHANGELOG, 'slug')).toEqual(['CHANGELOG.md', false])
  })

  it('reads a dict-shaped metadata field', () => {
    const d = doc({ id: 'd', name: 'N', doc_metadata: { slug: 'a/b' } })
    expect(extractSlug(d, 'slug')).toEqual(['a/b', true])
  })
})

describe('extractDocumentSize', () => {
  it('reads the uploaded source file size', () => {
    expect(extractDocumentSize(QUICKSTART)).toBe(180)
  })

  it('returns null when no upload size is present', () => {
    expect(extractDocumentSize(CHANGELOG)).toBeNull()
  })
})

describe('scalarString', () => {
  it('coerces primitives and rejects objects', () => {
    expect(scalarString('x')).toBe('x')
    expect(scalarString(5)).toBe('5')
    expect(scalarString(true)).toBe('true')
    expect(scalarString(null)).toBeNull()
    expect(scalarString({})).toBeNull()
  })
})

describe('timestampToIso', () => {
  it('converts an epoch-seconds number to ISO', () => {
    expect(timestampToIso(1716282000)).toBe('2024-05-21T09:00:00.000Z')
  })

  it('passes strings through and empties everything else', () => {
    expect(timestampToIso('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00Z')
    expect(timestampToIso(null)).toBe('')
    expect(timestampToIso({})).toBe('')
  })
})

describe('buildDirEntries', () => {
  it('maps slugs to a directory tree with file entries', () => {
    const entries = buildDirEntries([QUICKSTART, CHANGELOG], '', 'slug')
    expect([...entries.keys()].sort()).toEqual(['/', '/guides'])

    const guides = entryFor(entries, '/', 'guides')
    expect(guides?.resourceType).toBe('folder')

    const changelog = entryFor(entries, '/', 'CHANGELOG.md')
    expect(changelog?.resourceType).toBe('file')
    expect(changelog?.extra.has_slug).toBe(false)

    const quickstart = entryFor(entries, '/guides', 'quickstart')
    expect(quickstart?.resourceType).toBe('file')
    expect(quickstart?.extra.slug).toBe('guides/quickstart')
    expect(quickstart?.extra.has_slug).toBe(true)
  })

  it('drops the deeper document whose ancestor is itself a file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const leaf = doc({ id: 'leaf', name: 'L', doc_metadata: [{ name: 'slug', value: 'guides' }] })
    const entries = buildDirEntries([QUICKSTART, leaf], '', 'slug')
    // 'guides' is a file, so 'guides/quickstart' is dropped and no '/guides'
    // directory is created (mirrors python skip_path_collisions).
    expect(entryFor(entries, '/', 'guides')?.resourceType).toBe('file')
    expect(entries.has('/guides')).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
