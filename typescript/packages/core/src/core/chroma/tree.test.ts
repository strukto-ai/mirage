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

import { encodeBase64 } from '../../utils/base64.ts'
import { gzip } from '../../utils/compress.ts'
import { buildDirEntries, normalizeSlug, parsePathTree, virtualPath } from './tree.ts'

const ENC = new TextEncoder()

const TREE = {
  'guides/quickstart.md': { size: 180, updated_at: '2026-02-01T00:00:00Z' },
  'CHANGELOG.md': { size: 90 },
}

describe('parsePathTree', () => {
  it('parses plain JSON', async () => {
    const parsed = await parsePathTree(JSON.stringify(TREE))
    expect(Object.keys(parsed).sort()).toEqual(['CHANGELOG.md', 'guides/quickstart.md'])
    expect(parsed['CHANGELOG.md']).toEqual({ size: 90 })
  })

  it('parses gzip+base64', async () => {
    const raw = encodeBase64(await gzip(ENC.encode(JSON.stringify(TREE))))
    const parsed = await parsePathTree(raw)
    expect(parsed['guides/quickstart.md']).toEqual({
      size: 180,
      updated_at: '2026-02-01T00:00:00Z',
    })
  })

  it('rejects invalid documents', async () => {
    await expect(parsePathTree('not json, not base64')).rejects.toThrow(
      'Invalid Chroma path tree document',
    )
  })

  it('rejects non-object JSON', async () => {
    await expect(parsePathTree('[1, 2]')).rejects.toThrow('Chroma path tree must be a JSON object')
  })

  it('coerces non-object metadata to empty', async () => {
    const parsed = await parsePathTree('{"a.md": 5}')
    expect(parsed['a.md']).toEqual({})
  })
})

describe('normalizeSlug', () => {
  it('normalizes slashes', () => {
    expect(normalizeSlug('/guides//auth.md/')).toBe('/guides/auth.md')
  })

  it('rejects empty paths', () => {
    expect(() => normalizeSlug('//')).toThrow('Invalid empty Chroma path')
  })

  it('rejects dot segments', () => {
    expect(() => normalizeSlug('a/../b.md')).toThrow("Invalid Chroma path segment: '..'")
    expect(() => normalizeSlug('./a.md')).toThrow("Invalid Chroma path segment: '.'")
  })
})

describe('buildDirEntries', () => {
  it('builds directories and file entries', () => {
    const entries = buildDirEntries(
      {
        'guides/auth.md': { size: 190, updated_at: '2026-02-15T00:00:00Z' },
        'CHANGELOG.md': { size: 90 },
      },
      '/knowledge/',
    )
    expect([...entries.keys()].sort()).toEqual(['/knowledge', '/knowledge/guides'])
    const root = entries.get('/knowledge') ?? []
    expect(root.map(([name]) => name).sort()).toEqual(['CHANGELOG.md', 'guides'])
    const guides = entries.get('/knowledge/guides') ?? []
    expect(guides).toHaveLength(1)
    const auth = guides[0]?.[1]
    expect(auth?.resourceType).toBe('file')
    // The path tree's own size never becomes the byte length: it describes
    // the producer's source document, so it rides in extra and the size is
    // measured later, from the rendered chunks.
    expect(auth?.size).toBeNull()
    expect(auth?.extra.source_size).toBe(190)
    expect(auth?.extra.slug).toBe('guides/auth.md')
    expect(auth?.extra.updated_at).toBe('2026-02-15T00:00:00Z')
  })

  it('rejects duplicate paths', () => {
    expect(() => buildDirEntries({ 'a.md': {}, '/a.md/': {} }, '')).toThrow(
      "Duplicate Chroma path 'a.md'",
    )
  })

  it('rejects file/directory collisions', () => {
    expect(() => buildDirEntries({ a: {}, 'a/b.md': {} }, '')).toThrow('Path collision')
  })
})

describe('virtualPath', () => {
  it('maps tree paths under the mount root', () => {
    expect(virtualPath('/', '/knowledge/')).toBe('/knowledge')
    expect(virtualPath('/guides', '/knowledge/')).toBe('/knowledge/guides')
    expect(virtualPath('/guides', '')).toBe('/guides')
  })
})
