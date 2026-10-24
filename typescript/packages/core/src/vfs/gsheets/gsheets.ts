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
import { GSheetsAccessor } from '../../accessor/gsheets.ts'

import { TokenManager } from '../../core/google/client.ts'
import { type DirListing, VFSName } from '../../types.ts'

import { redactGSheetsConfig, type GSheetsConfig, type GSheetsConfigRedacted } from './config.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { SHEETS_WORDS } from '../../utils/generated/google_vocabulary.ts'
import { filesContaining as googleFilesContaining } from '../../core/google/search.ts'
import { MIME } from '../../core/gsheets/constants.ts'
import { readdir as gsheetsReaddir } from '../../core/gsheets/readdir.ts'
import { read as gsheetsRead } from '../../core/gsheets/read.ts'
import { stat as gsheetsStat } from '../../core/gsheets/stat.ts'
import { appDeltaHook } from '../../core/google/events.ts'
import { makeFilename } from './sheet_entry.ts'
import type { DeltaHook } from '../../events/base.ts'
import { unlink as gsheetsUnlink } from '../../core/gsheets/unlink.ts'
import { rename as gsheetsRename } from '../../core/gsheets/rename.ts'
import { WALK_LIMIT } from '../constants.ts'

export const VFS_MD = `{prefix}
  owned/
    <date>_<title>__<spreadsheet-id>.gsheet.json
  shared/
    <date>_<title>__<spreadsheet-id>.gsheet.json

  Filename: <YYYY-MM-DD>_<title>__<spreadsheet-id>.gsheet.json
    <YYYY-MM-DD>      modifiedTime, used for date-glob (e.g. 2026-05-*)
    <title>           sanitized: spaces->_, non-[A-Za-z0-9_.-]->_, <=100 chars
    <spreadsheet-id>  Google Sheets spreadsheet ID

  Buckets:
    owned/   sheets you created
    shared/  sheets shared with you by others
             - does NOT include sheets you own and shared with others;
               those are still in owned/.

  gsheet.json structure (matches the Google Sheets API spreadsheets.get response):
    {
      "spreadsheetId": "...",
      "spreadsheetUrl": "...",
      "properties": { "title": "...", "locale": "...", "timeZone": "..." },
      "sheets": [
        {                                      # one element per tab
          "properties": {
            "sheetId": 0, "title": "...", "index": 0,
            "gridProperties": { "rowCount": 1000, "columnCount": 26 }
          },
          "data": [
            {
              "rowData": [
                { "values": [
                    { "formattedValue": "...",
                      "userEnteredValue": {...},
                      "effectiveValue": {...} }
                ]}    # an empty cell is {}, a trailing one absent
              ]
            }
          ]
        }
      ],
      "namedRanges": [...]
    }

  Useful jq paths:
    .properties.title
    .sheets[].properties.title                              # tab names
    .sheets[0].data[0].rowData[].values[].formattedValue    # cell strings
    .namedRanges[]

  For range-scoped reads and writes, use the gws CLI if installed:
    gws sheets read --spreadsheet <id> --range Sheet1!A1:C10

  Delete:
    rm {prefix}/owned/<file>.gsheet.json     # permanent delete from Drive
    rm -f <path>                             # ignore if missing
    Only operates on .gsheet.json files; owned/ and shared/ themselves
    cannot be removed.

  Rename (a new title):
    mv {prefix}/owned/<date>_<old>__<id>.gsheet.json \\
       {prefix}/owned/<date>_<new>__<id>.gsheet.json
    Keep the folder, the date and the id, and spell the title the way
    the listing does (spaces->_); any other name is refused.`

export interface GSheetsVFSState {
  type: string
  config: GSheetsConfigRedacted
}

export class GSheetsVFS extends BaseVFS {
  override readonly name: string = VFSName.GSHEETS
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  // Reads stamp listing metadata; a fresh stat checks Drive by file ID.
  override readonly readRevalidatable: boolean = true
  override vfsMd: string = VFS_MD
  override readonly wholeWordSearch: boolean = true
  readonly config: GSheetsConfig
  override readonly accessor: GSheetsAccessor

  override readonly walkLimit: number

  constructor(config: GSheetsConfig) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    const tm = new TokenManager(config)
    this.accessor = new GSheetsAccessor({ tokenManager: tm })
  }

  override readonly handed = {
    unlink: ['entry'],
    rename: ['entry'],
  } as const

  override readonly renderers: Readonly<Record<string, string>> = { '.gsheet.json': 'readSheet' }

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
    return googleFilesContaining(this.accessor, gsheetsReaddir, MIME, SHEETS_WORDS, text, [path])
  }

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return gsheetsReaddir(this.accessor, path)
  }

  /** Render the file as the JSON its `.gsheet.json` name holds. */
  async readSheet(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await gsheetsRead(this.accessor, path)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return gsheetsStat(this.accessor, path)
  }

  override unlink(path: PathSpec, handed?: Handed): Promise<void> {
    return gsheetsUnlink(this.accessor, path, handed?.entry)
  }

  override rename(src: PathSpec, dst: PathSpec, handed?: Handed): Promise<void> {
    return gsheetsRename(this.accessor, src, dst, handed?.entry ?? null)
  }

  override deltaHook(): DeltaHook {
    return appDeltaHook(this.accessor, MIME, makeFilename)
  }

  override getState(): Promise<GSheetsVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGSheetsConfig(this.config),
    })
  }
}
