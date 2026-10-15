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
import { DirListing, FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { DetectFn } from '../hierarchy/scope.ts'
import { TOP_LEVEL_DIRS } from './constants.ts'
import { globToModifiedRange } from './date_glob.ts'
import { listAllFiles } from './drive.ts'
import { appFile } from './entry.ts'

export type AppReaddir = (
  accessor: GoogleApiAccessor,
  path: PathSpec,
) => Promise<FileStat[] | DirListing>

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
): AppReaddir {
  return async (accessor, path) => {
    const prefix = mountPrefixOf(path.virtual, path.vfsPath)
    const modifiedRange = path.pattern ? globToModifiedRange(path.pattern) : null
    let p = path.pattern ? path.directory : path.virtual
    if (prefix !== '' && p.startsWith(prefix)) {
      const rest = p.slice(prefix.length)
      if (prefix.endsWith('/') || rest === '' || rest.startsWith('/')) p = rest || '/'
    }
    const key = stripSlash(p)

    // Bespoke below the classifier: the date-glob push-down filters the
    // Drive query itself, and a filtered or incomplete listing is no listing
    // of the directory, which the kit readdir has no notion of.
    const match = detectScope(p)
    if (match.kind === 'root') {
      return TOP_LEVEL_DIRS.map((d) => new FileStat({ name: d, type: FileType.DIRECTORY }))
    }
    if (match.kind !== 'corpus') throw enoent(path.virtual)

    const { files, complete } = await listAllFiles(accessor.tokenManager, {
      mimeType: mime,
      modifiedAfter: modifiedRange ? modifiedRange[0] : null,
      modifiedBefore: modifiedRange ? modifiedRange[1] : null,
    })
    const isOwned = key === 'owned'
    const rows: FileStat[] = []
    for (const f of files) {
      const firstOwner = (f.owners ?? [])[0] ?? {}
      if ((firstOwner.me === true) !== isOwned) continue
      rows.push(appFile(makeFilename(f.name, f.id, f.modifiedTime ?? ''), f))
    }
    // A modified-range listing is a filtered view rather than the directory,
    // and an incomplete all-corpora search is a directory Drive could not
    // finish reading. Neither may stand in for the directory: keeping one
    // would pin a short listing until it expires. The rows are real either
    // way.
    return new DirListing({ entries: rows, partial: modifiedRange !== null || !complete })
  }
}
