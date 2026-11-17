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

import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { MIME } from '../../core/gdocs/constants.ts'
import { read as gdocsRead } from '../../core/gdocs/read.ts'
import { readdir as gdocsReaddir } from '../../core/gdocs/readdir.ts'
import { rename as gdocsRename } from '../../core/gdocs/rename.ts'
import { stat as gdocsStat } from '../../core/gdocs/stat.ts'
import { unlink as gdocsUnlink } from '../../core/gdocs/unlink.ts'
import { TokenManager } from '../../core/google/client.ts'
import type { GoogleConfig } from '../../core/google/config.ts'
import { appDeltaHook } from '../../core/google/events.ts'
import { filesContaining as googleFilesContaining } from '../../core/google/search.ts'
import type { DeltaHook } from '../../events/base.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { VFSName, type DirListing } from '../../types.ts'
import { DOCS_WORDS } from '../../utils/generated/google_vocabulary.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { BaseVFS } from '../base.ts'
import type { RedactedSchema } from '../secrets.ts'
import type { ConfigState, Handed } from '../types.ts'
import { GDocsConfig } from './config.ts'
import { makeFilename } from './doc_entry.ts'

export const VFS_MD = `\`\`\`text
{prefix}
  owned/     # docs you created
    <YYYY-MM-DD>_<title>__<doc-id>.gdoc.json
  shared/    # docs others shared with you
    <YYYY-MM-DD>_<title>__<doc-id>.gdoc.json
\`\`\`

- \`<YYYY-MM-DD>\` is the file's \`modifiedTime\`, so a date glob such as
  \`2026-05-*\` narrows the query; \`<title>\` turns spaces and characters
  outside \`[A-Za-z0-9_.-]\` into \`_\`, at most 100 characters.
- \`shared/\` holds docs others shared; docs owned and shared out stay
  in \`owned/\`.
- A file is the Docs API \`documents.get\` response with every tab under
  \`.tabs[].documentTab\`, nested through \`.childTabs\`; there is no
  top-level \`.body\`. All text: \`[.. | .textRun? // empty | .content] | add\`.
- On a \`write\` path, \`rm\` a file to delete it from Drive, or \`mv\` it to a
  new \`<title>\` with the same folder, date and id to rename it.`

export class GDocsVFS extends BaseVFS {
  override readonly name: string = VFSName.GDOCS
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  // Reads stamp listing metadata; a fresh stat checks Drive by file ID.
  override readonly readRevalidatable: boolean = true
  override vfsMd: string = VFS_MD
  override readonly wholeWordSearch: boolean = true
  override readonly searchNeedsWalkLimit: boolean = true
  readonly config: GDocsConfig
  override readonly accessor: GDocsAccessor

  constructor(config: GDocsConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GDocsAccessor({ tokenManager: tm })
  }

  override readonly handed = {
    unlink: ['entry'],
    rename: ['entry'],
  } as const

  override readonly renderers: Readonly<Record<string, string>> = { '.gdoc.json': 'readDoc' }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord || this.walkLimit < 0) return Promise.resolve(null)
    return googleFilesContaining(this.accessor, gdocsReaddir, MIME, DOCS_WORDS, text, [path])
  }

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return gdocsReaddir(this.accessor, path)
  }

  /** Render the file as the JSON its `.gdoc.json` name holds. */
  async readDoc(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await gdocsRead(this.accessor, path)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return gdocsStat(this.accessor, path)
  }

  override unlink(path: PathSpec, handed?: Handed): Promise<void> {
    return gdocsUnlink(this.accessor, path, handed?.entry)
  }

  override rename(src: PathSpec, dst: PathSpec, handed?: Handed): Promise<void> {
    return gdocsRename(this.accessor, src, dst, handed?.entry ?? null)
  }

  override deltaHook(): DeltaHook {
    return appDeltaHook(this.accessor, MIME, makeFilename)
  }

  override getState(): Promise<ConfigState<RedactedSchema<typeof GoogleConfig>>> {
    return Promise.resolve(this.configState(GDocsConfig, this.config))
  }
}
