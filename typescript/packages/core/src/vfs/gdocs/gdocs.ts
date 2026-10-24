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
import { GDocsAccessor } from '../../accessor/gdocs.ts'

import { TokenManager } from '../../core/google/client.ts'
import { type DirListing, VFSName } from '../../types.ts'

import { redactGDocsConfig, type GDocsConfig, type GDocsConfigRedacted } from './config.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { DOCS_WORDS } from '../../utils/generated/google_vocabulary.ts'
import { filesContaining as googleFilesContaining } from '../../core/google/search.ts'
import { MIME } from '../../core/gdocs/constants.ts'
import { readdir as gdocsReaddir } from '../../core/gdocs/readdir.ts'
import { read as gdocsRead } from '../../core/gdocs/read.ts'
import { stat as gdocsStat } from '../../core/gdocs/stat.ts'
import { appDeltaHook } from '../../core/google/events.ts'
import { makeFilename } from './doc_entry.ts'
import type { DeltaHook } from '../../events/base.ts'
import { unlink as gdocsUnlink } from '../../core/gdocs/unlink.ts'
import { rename as gdocsRename } from '../../core/gdocs/rename.ts'
import { WALK_LIMIT } from '../constants.ts'

export const VFS_MD = `{prefix}
  owned/
    <date>_<title>__<doc-id>.gdoc.json
  shared/
    <date>_<title>__<doc-id>.gdoc.json

  Filename: <YYYY-MM-DD>_<title>__<doc-id>.gdoc.json
    <YYYY-MM-DD>  modifiedTime, used for date-glob (e.g. 2026-05-*)
    <title>       sanitized: spaces->_, non-[A-Za-z0-9_.-]->_, <=100 chars
    <doc-id>      Google Docs document ID

  Buckets:
    owned/   docs you created
    shared/  docs shared with you by others
             - does NOT include docs you own and shared with others;
               those are still in owned/.

  gdoc.json structure (the Google Docs API documents.get response, read
  with includeTabsContent=true so every tab is present):
    {
      "documentId": "...",
      "title": "...",
      "tabs": [                          # one entry per top-level tab
        {
          "tabProperties": {
            "tabId": "t.0",              # names a tab for gws docs write
            "title": "Tab 1",
            "index": 0
          },
          "documentTab": {
            "body": {
              "content": [
                {                          # one element per block
                  "paragraph": {
                    "elements": [
                      { "textRun": { "content": "the actual text\\n",
                                     "textStyle": {...} } }
                    ],
                    "paragraphStyle": {...}
                  }
                },
                { "table": {...} },
                { "sectionBreak": {...} }
              ]
            },
            "documentStyle": {...},
            "namedStyles": {...}
          },
          "childTabs": [ { ...same shape, nested to any depth... } ]
                                       # a NESTED tab additionally carries
                                       # parentTabId and nestingLevel; a
                                       # root tab carries neither
        }
      ],
      "revisionId": "..."
    }

  There is no top-level .body. A tab-aware response leaves the singleton
  fields (.body, .documentStyle, .namedStyles) empty and hangs every
  tab's content off .tabs[].documentTab instead. Tabs also nest, so text
  can sit at any depth under .childTabs; the recursive recipes below read
  a one-tab and a fifty-tab document alike.

  Useful jq paths:
    .title
    [.. | .tabProperties? // empty | .title]             # every tab name
    [.. | .textRun? // empty | .content] | add           # all text, any depth
    [.. | .tabProperties? // empty] | length             # tab count
    [.tabs[0].documentTab.body.content[]
      | .paragraph?.elements[]?.textRun.content] | add   # first tab only
    .revisionId

  The first block of a body is always a sectionBreak, which carries no
  .paragraph, so a path through .paragraph needs the \`?\` or it fails with
  "Cannot iterate over null".

  Delete:
    rm {prefix}/owned/<file>.gdoc.json      # permanent delete from Drive
    rm -f <path>                            # ignore if missing
    Only operates on .gdoc.json files; owned/ and shared/ themselves
    cannot be removed.

  Rename (a new title):
    mv {prefix}/owned/<date>_<old>__<id>.gdoc.json \\
       {prefix}/owned/<date>_<new>__<id>.gdoc.json
    Keep the folder, the date and the id, and spell the title the way
    the listing does (spaces->_); any other name is refused.`

export interface GDocsVFSState {
  type: string
  config: GDocsConfigRedacted
}

export class GDocsVFS extends BaseVFS {
  override readonly name: string = VFSName.GDOCS
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  // Reads stamp listing metadata; a fresh stat checks Drive by file ID.
  override readonly readRevalidatable: boolean = true
  override vfsMd: string = VFS_MD
  override readonly wholeWordSearch: boolean = true
  readonly config: GDocsConfig
  override readonly accessor: GDocsAccessor

  override readonly walkLimit: number

  constructor(config: GDocsConfig) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    const tm = new TokenManager(config)
    this.accessor = new GDocsAccessor({ tokenManager: tm })
  }

  override readonly handed = {
    unlink: ['entry'],
    rename: ['entry'],
  } as const

  override readonly renderers: Readonly<Record<string, string>> = { '.gdoc.json': 'readDoc' }

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

  override getState(): Promise<GDocsVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGDocsConfig(this.config),
    })
  }
}
