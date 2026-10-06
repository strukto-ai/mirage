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

import { typedSpec } from '@struktoai/mirage-core/utils/path'
import { describe, expect, it } from 'vitest'
import {
  blobPath,
  cacheRoot,
  etagOf,
  linkTarget,
  refPath,
  repoFolderName,
  snapshotDir,
  snapshotPath,
} from './cache.ts'
import type { TreeEntry } from './tree_entry.ts'

function entry(path: string, oid = 'oid1', lfsOid = ''): TreeEntry {
  return {
    path,
    type: 'file',
    oid,
    size: 3,
    lastModified: '',
    lastCommit: '',
    lfsOid,
    xetHash: '',
  }
}

describe('repoFolderName', () => {
  it.each([
    ['julien-c/EsperBERTo-small', 'model', 'models--julien-c--EsperBERTo-small'],
    ['acme/rows', 'dataset', 'datasets--acme--rows'],
    ['acme/demo', 'space', 'spaces--acme--demo'],
  ])('matches upstream for %s as a %s', (repoId, repoType, expected) => {
    // Upstream's own spelling: the plural kind and the id's halves joined by
    // `--`, flattened so a namespace cannot nest and two repos cannot collide
    // across kinds.
    expect(repoFolderName(repoId, repoType)).toBe(expected)
  })
})

describe('etagOf', () => {
  it('prefers the LFS sha, which is what the resolve ETag carries', () => {
    expect(etagOf(entry('a.bin', 'git1', 'lfs1'))).toBe('lfs1')
    expect(etagOf(entry('a.txt', 'git1'))).toBe('git1')
  })
})

describe('layout paths', () => {
  const folder = repoFolderName('acme/w', 'model')

  it('places blobs, refs and snapshots the way upstream does', () => {
    expect(blobPath('/c', folder, 'e1').virtual).toBe('/c/models--acme--w/blobs/e1')
    expect(refPath('/c', folder, 'main').virtual).toBe('/c/models--acme--w/refs/main')
    expect(snapshotDir('/c', folder, 'sha').virtual).toBe('/c/models--acme--w/snapshots/sha')
    expect(snapshotPath('/c', folder, 'sha', 'sub/b.json').virtual).toBe(
      '/c/models--acme--w/snapshots/sha/sub/b.json',
    )
  })
})

describe('linkTarget', () => {
  it.each([
    ['a.txt', '../../blobs/e1'],
    ['sub/b.json', '../../../blobs/e1'],
    ['sub/deep/c.bin', '../../../../blobs/e1'],
  ])('is relative to the entry for %s', (repoPath, expected) => {
    // Relative because upstream's cache is relocatable: the whole directory
    // can be moved and every link still resolves.
    expect(linkTarget(repoPath, 'e1')).toBe(expected)
  })
})

describe('cacheRoot', () => {
  it('reads upstream order', () => {
    expect(cacheRoot({ HF_HUB_CACHE: '/x' })).toBe('/x')
    expect(cacheRoot({ HF_HOME: '/h' })).toBe('/h/hub')
    expect(cacheRoot({ HF_HUB_CACHE: '/x', HF_HOME: '/h' })).toBe('/x')
  })

  it('reports that nothing named one', () => {
    // A workspace has no home directory, so upstream's last fallback is the
    // step that cannot be taken; the caller reports it rather than inventing
    // a path.
    expect(cacheRoot({})).toBeNull()
  })
})

it('keeps the cache roots directory walk', () => {
  const root = typedSpec('/hidden/../cache', '/')
  const blob = blobPath(root, 'models--acme--w', 'e1')
  expect(blob.virtual).toBe('/cache/models--acme--w/blobs/e1')
  expect(blob.dotted).toBe('/hidden/../cache/models--acme--w/blobs/e1')
})
