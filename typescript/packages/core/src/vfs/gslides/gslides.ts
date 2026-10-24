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

import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'
import { GSlidesAccessor } from '../../accessor/gslides.ts'

import { TokenManager } from '../../core/google/client.ts'
import { type DirListing, VFSName } from '../../types.ts'

import { redactGSlidesConfig, type GSlidesConfig, type GSlidesConfigRedacted } from './config.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { SLIDES_WORDS } from '../../utils/generated/google_vocabulary.ts'
import { filesContaining as googleFilesContaining } from '../../core/google/search.ts'
import { MIME } from '../../core/gslides/constants.ts'
import { readdir as gslidesReaddir } from '../../core/gslides/readdir.ts'
import { read as gslidesRead } from '../../core/gslides/read.ts'
import { stat as gslidesStat } from '../../core/gslides/stat.ts'
import { appDeltaHook } from '../../core/google/events.ts'
import { makeFilename } from './slide_entry.ts'
import type { DeltaHook } from '../../events/base.ts'
import { unlink as gslidesUnlink } from '../../core/gslides/unlink.ts'
import { rename as gslidesRename } from '../../core/gslides/rename.ts'
import { WALK_LIMIT } from '../constants.ts'

export const VFS_MD = `{prefix}
  owned/
    <date>_<title>__<presentation-id>.gslide.json
  shared/
    <date>_<title>__<presentation-id>.gslide.json

  Filename: <YYYY-MM-DD>_<title>__<presentation-id>.gslide.json
    <YYYY-MM-DD>       modifiedTime, used for date-glob (e.g. 2026-05-*)
    <title>            sanitized: spaces->_, non-[A-Za-z0-9_.-]->_, <=100 chars
    <presentation-id>  Google Slides presentation ID

  Buckets:
    owned/   presentations you created
    shared/  presentations shared with you by others
             - does NOT include presentations you own and shared with others;
               those are still in owned/.

  gslide.json structure (matches the Google Slides API presentations.get response):
    {
      "presentationId": "...",
      "title": "...",
      "pageSize": { "width": {...}, "height": {...} },
      "slides": [
        {                                      # one element per slide
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

  Useful jq paths:
    .title
    .slides | length                                                    # slide count
    .slides[].pageElements[].shape.text.textElements[].textRun.content  # all text
    .slides[0].objectId

  Delete:
    rm {prefix}/owned/<file>.gslide.json     # permanent delete from Drive
    rm -f <path>                             # ignore if missing
    Only operates on .gslide.json files; owned/ and shared/ themselves
    cannot be removed.

  Rename (a new title):
    mv {prefix}/owned/<date>_<old>__<id>.gslide.json \\
       {prefix}/owned/<date>_<new>__<id>.gslide.json
    Keep the folder, the date and the id, and spell the title the way
    the listing does (spaces->_); any other name is refused.`

export interface GSlidesVFSState {
  type: string
  config: GSlidesConfigRedacted
}

export class GSlidesVFS extends BaseVFS {
  override readonly name: string = VFSName.GSLIDES
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  // Reads stamp listing metadata; a fresh stat checks Drive by file ID.
  override readonly readRevalidatable: boolean = true
  override vfsMd: string = VFS_MD
  override readonly wholeWordSearch: boolean = true
  readonly config: GSlidesConfig
  override readonly accessor: GSlidesAccessor

  override readonly walkLimit: number

  constructor(config: GSlidesConfig) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    const tm = new TokenManager(config)
    this.accessor = new GSlidesAccessor({ tokenManager: tm })
  }

  override readonly handed = {
    unlink: ['entry'],
    rename: ['entry'],
  } as const

  override readonly renderers: Readonly<Record<string, string>> = { '.gslide.json': 'readDeck' }

  /**
   * Whether this VFS answers `name`; with no walk limit it reads every
   * file rather than ask the service's search.
   */
  override supports(name: string): boolean {
    if (name === 'files_containing' && this.fullScanLimit < 0) return false
    return super.supports(name)
  }

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

  override getState(): Promise<GSlidesVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGSlidesConfig(this.config),
    })
  }
}
