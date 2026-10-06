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

import type { GoogleApiAccessor } from '../../accessor/google_api.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { DetectFn } from '../hierarchy/scope.ts'
import { TOP_LEVEL_DIRS } from './constants.ts'
import { globToModifiedRange } from './date_glob.ts'
import { listAllFiles } from './drive.ts'

export type AppReaddir = (
  accessor: GoogleApiAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<string[]>

/**
 * The readdir of a Google app mount: its corpora and their files. Sheets,
 * Docs and Slides list the same tree, one Drive query per corpus narrowed to
 * the app's MIME type, and differ only in what they name a file and how they
 * classify a path. Mirrors Python's `make_app_readdir`.
 */
export function makeAppReaddir(
  mime: string,
  detectScope: DetectFn,
  makeFilename: (title: string, fileId: string, modifiedTime: string) => string,
  resourceType: string,
): AppReaddir {
  return async (accessor, path, index) => {
    const prefix = mountPrefixOf(path.virtual, path.vfsPath)
    const modifiedRange = path.pattern ? globToModifiedRange(path.pattern) : null
    let p = path.pattern ? path.directory : path.virtual
    if (prefix !== '' && p.startsWith(prefix)) {
      const rest = p.slice(prefix.length)
      if (prefix.endsWith('/') || rest === '' || rest.startsWith('/')) p = rest || '/'
    }
    const key = stripSlash(p)
    const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'

    // Bespoke below the classifier: the date-glob push-down filters the
    // Drive query itself, and a filtered or incomplete listing must not be
    // cached as the directory, which the kit readdir has no notion of.
    const match = detectScope(p)
    if (match.kind === 'root') return TOP_LEVEL_DIRS.map((d) => `${prefix}/${d}`)
    if (match.kind !== 'corpus') throw enoent(path.virtual)

    if (index !== undefined && modifiedRange === null) {
      const cached = await index.listDir(virtualKey)
      if (cached.entries !== undefined && cached.entries !== null) return cached.entries
    }

    const { files, complete } = await listAllFiles(accessor.tokenManager, {
      mimeType: mime,
      modifiedAfter: modifiedRange ? modifiedRange[0] : null,
      modifiedBefore: modifiedRange ? modifiedRange[1] : null,
    })
    const isOwned = key === 'owned'
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const f of files) {
      const firstOwner = (f.owners ?? [])[0] ?? {}
      if ((firstOwner.me === true) !== isOwned) continue
      const filename = makeFilename(f.name, f.id, f.modifiedTime ?? '')
      const sourceSize = Number.parseInt(f.size ?? f.quotaBytesUsed ?? '0', 10)
      // size stays null: Drive reports the source document's storage size, not
      // the rendered JSON length (FileStat.size must be render-derived or
      // null, see the CLAUDE.md FUSE rules). The source size lives in extra.
      entries.push([
        filename,
        new IndexEntry({
          id: f.id,
          name: f.name,
          resourceType,
          remoteTime: f.modifiedTime ?? '',
          vfsName: filename,
          extra: Number.isFinite(sourceSize) && sourceSize > 0 ? { source_size: sourceSize } : {},
        }),
      ])
      names.push(`${prefix}/${key}/${filename}`)
    }

    if (index !== undefined) {
      // A modified-range listing is a filtered view rather than the directory,
      // and an incomplete all-corpora search is a directory Drive could not
      // finish reading. Neither may stand in for the directory: caching one
      // would pin a short listing until it expires. The entries are real
      // either way, so cache those and let the next readdir re-list.
      if (modifiedRange !== null || !complete) {
        for (const [name, entry] of entries) await index.put(`${virtualKey}/${name}`, entry)
      } else {
        await index.setDir(virtualKey, entries)
      }
    }
    return names
  }
}
