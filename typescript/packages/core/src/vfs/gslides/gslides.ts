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

import { GSlidesAccessor } from '../../accessor/gslides.ts'
import { TokenManager } from '../../core/google/client.ts'
import type { GoogleConfig } from '../../core/google/config.ts'
import { appDeltaHook } from '../../core/google/events.ts'
import { filesContaining as googleFilesContaining } from '../../core/google/search.ts'
import { MIME } from '../../core/gslides/constants.ts'
import { read as gslidesRead } from '../../core/gslides/read.ts'
import { readdir as gslidesReaddir } from '../../core/gslides/readdir.ts'
import { rename as gslidesRename } from '../../core/gslides/rename.ts'
import { stat as gslidesStat } from '../../core/gslides/stat.ts'
import { unlink as gslidesUnlink } from '../../core/gslides/unlink.ts'
import type { DeltaHook } from '../../events/base.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { VFSName, type DirListing } from '../../types.ts'
import { SLIDES_WORDS } from '../../utils/generated/google_vocabulary.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { BaseVFS } from '../base.ts'
import type { RedactedSchema } from '../secrets.ts'
import type { ConfigState, Handed } from '../types.ts'
import { GSlidesConfig } from './config.ts'
import { makeFilename } from './slide_entry.ts'

export const VFS_MD = `\`\`\`text
{prefix}
  owned/     # presentations you created
    <YYYY-MM-DD>_<title>__<presentation-id>.gslide.json
  shared/    # presentations others shared with you
    <YYYY-MM-DD>_<title>__<presentation-id>.gslide.json
\`\`\`

- \`<YYYY-MM-DD>\` is the file's \`modifiedTime\`, so a date glob such as
  \`2026-05-*\` narrows by it.
- \`<title>\` is sanitized: spaces and any character outside
  \`[A-Za-z0-9_.-]\` become \`_\`, at most 100 characters.
- \`<presentation-id>\` is the Google Slides presentation id.
- \`shared/\` holds presentations shared with you by others; ones you own
  and shared with others are still in \`owned/\`.

A \`.gslide.json\` matches the Google Slides API \`presentations.get\`
response:

\`\`\`jsonc
{
  "presentationId": "...",
  "title": "...",
  "pageSize": { "width": {...}, "height": {...} },
  "slides": [
    {                                      // one element per slide
      "objectId": "...",
      "pageElements": [
        {
          "objectId": "...",
          "shape": {
            "shapeType": "TEXT_BOX",
            "text": {
              "textElements": [
                { "textRun": { "content": "the actual text\\n",
                               "style": {...} } }
              ]
            }
          }
        },
        { "image": {...} },
        { "table": {...} }
      ]
    }
  ],
  "masters": [...],
  "layouts": [...]
}
\`\`\`

Useful \`jq\` paths:

\`\`\`jq
.title
.slides | length                                                    # slide count
.slides[].pageElements[].shape.text.textElements[].textRun.content  # all text
.slides[0].objectId
\`\`\`

Delete, on a \`write\` path:

\`\`\`sh
rm {prefix}/owned/<file>.gslide.json   # deletes it from Drive for good
rm -f <path>                       # ignores a missing file
\`\`\`

Only \`.gslide.json\` files can be removed; \`owned/\` and \`shared/\` cannot.

Rename to a new title, on a \`write\` path:

\`\`\`sh
mv {prefix}/owned/<date>_<old>__<id>.gslide.json \\
   {prefix}/owned/<date>_<new>__<id>.gslide.json
\`\`\`

Keep the folder, the date and the id, and spell the title the way the
listing does (spaces become \`_\`); any other name is refused.`

export class GSlidesVFS extends BaseVFS {
  override readonly name: string = VFSName.GSLIDES
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  // Reads stamp listing metadata; a fresh stat checks Drive by file ID.
  override readonly readRevalidatable: boolean = true
  override vfsMd: string = VFS_MD
  override readonly wholeWordSearch: boolean = true
  override readonly searchNeedsWalkLimit: boolean = true
  readonly config: GSlidesConfig
  override readonly accessor: GSlidesAccessor

  constructor(config: GSlidesConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GSlidesAccessor({ tokenManager: tm })
  }

  override readonly handed = {
    unlink: ['entry'],
    rename: ['entry'],
  } as const

  override readonly renderers: Readonly<Record<string, string>> = { '.gslide.json': 'readDeck' }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord || this.walkLimit < 0) return Promise.resolve(null)
    return googleFilesContaining(this.accessor, gslidesReaddir, MIME, SLIDES_WORDS, text, [path])
  }

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return gslidesReaddir(this.accessor, path)
  }

  /** Render the file as the JSON its `.gslide.json` name holds. */
  async readDeck(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await gslidesRead(this.accessor, path)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return gslidesStat(this.accessor, path)
  }

  override unlink(path: PathSpec, handed?: Handed): Promise<void> {
    return gslidesUnlink(this.accessor, path, handed?.entry)
  }

  override rename(src: PathSpec, dst: PathSpec, handed?: Handed): Promise<void> {
    return gslidesRename(this.accessor, src, dst, handed?.entry ?? null)
  }

  override deltaHook(): DeltaHook {
    return appDeltaHook(this.accessor, MIME, makeFilename)
  }

  override getState(): Promise<ConfigState<RedactedSchema<typeof GoogleConfig>>> {
    return Promise.resolve(this.configState(GSlidesConfig, this.config))
  }
}
