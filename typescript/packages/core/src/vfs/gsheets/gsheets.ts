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

import { GSheetsAccessor } from '../../accessor/gsheets.ts'
import { TokenManager } from '../../core/google/client.ts'
import type { GoogleConfig } from '../../core/google/config.ts'
import { appDeltaHook } from '../../core/google/events.ts'
import { filesContaining as googleFilesContaining } from '../../core/google/search.ts'
import { MIME } from '../../core/gsheets/constants.ts'
import { read as gsheetsRead } from '../../core/gsheets/read.ts'
import { readdir as gsheetsReaddir } from '../../core/gsheets/readdir.ts'
import { rename as gsheetsRename } from '../../core/gsheets/rename.ts'
import { stat as gsheetsStat } from '../../core/gsheets/stat.ts'
import { unlink as gsheetsUnlink } from '../../core/gsheets/unlink.ts'
import type { DeltaHook } from '../../events/base.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { VFSName, type DirListing } from '../../types.ts'
import { SHEETS_WORDS } from '../../utils/generated/google_vocabulary.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { BaseVFS } from '../base.ts'
import type { RedactedSchema } from '../secrets.ts'
import type { ConfigState, Handed } from '../types.ts'
import { GSheetsConfig } from './config.ts'
import { makeFilename } from './sheet_entry.ts'

export const VFS_MD = `\`\`\`text
{prefix}
  owned/     # sheets you created
    <YYYY-MM-DD>_<title>__<spreadsheet-id>.gsheet.json
  shared/    # sheets others shared with you
    <YYYY-MM-DD>_<title>__<spreadsheet-id>.gsheet.json
\`\`\`

- \`<YYYY-MM-DD>\` is the file's \`modifiedTime\`, so a date glob such as
  \`2026-05-*\` narrows by it.
- \`<title>\` is sanitized: spaces and any character outside
  \`[A-Za-z0-9_.-]\` become \`_\`, at most 100 characters.
- \`<spreadsheet-id>\` is the Google Sheets spreadsheet id.
- \`shared/\` holds sheets shared with you by others; ones you own
  and shared with others are still in \`owned/\`.

A \`.gsheet.json\` matches the Google Sheets API \`spreadsheets.get\`
response:

\`\`\`jsonc
{
  "spreadsheetId": "...",
  "spreadsheetUrl": "...",
  "properties": { "title": "...", "locale": "...", "timeZone": "..." },
  "sheets": [
    {                                      // one element per tab
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
            ]}    // an empty cell is {}, a trailing one absent
          ]
        }
      ]
    }
  ],
  "namedRanges": [...]
}
\`\`\`

Useful \`jq\` paths:

\`\`\`jq
.properties.title
.sheets[].properties.title                              # tab names
.sheets[0].data[0].rowData[].values[].formattedValue    # cell strings
.namedRanges[]
\`\`\`

Delete, on a \`write\` path:

\`\`\`sh
rm {prefix}/owned/<file>.gsheet.json   # deletes it from Drive for good
rm -f <path>                       # ignores a missing file
\`\`\`

Only \`.gsheet.json\` files can be removed; \`owned/\` and \`shared/\` cannot.

Rename to a new title, on a \`write\` path:

\`\`\`sh
mv {prefix}/owned/<date>_<old>__<id>.gsheet.json \\
   {prefix}/owned/<date>_<new>__<id>.gsheet.json
\`\`\`

Keep the folder, the date and the id, and spell the title the way the
listing does (spaces become \`_\`); any other name is refused.`

export class GSheetsVFS extends BaseVFS {
  override readonly name: string = VFSName.GSHEETS
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  // Reads stamp listing metadata; a fresh stat checks Drive by file ID.
  override readonly readRevalidatable: boolean = true
  override vfsMd: string = VFS_MD
  override readonly wholeWordSearch: boolean = true
  override readonly searchNeedsWalkLimit: boolean = true
  readonly config: GSheetsConfig
  override readonly accessor: GSheetsAccessor

  constructor(config: GSheetsConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GSheetsAccessor({ tokenManager: tm })
  }

  override readonly handed = {
    unlink: ['entry'],
    rename: ['entry'],
  } as const

  override readonly renderers: Readonly<Record<string, string>> = { '.gsheet.json': 'readSheet' }

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

  override getState(): Promise<ConfigState<RedactedSchema<typeof GoogleConfig>>> {
    return Promise.resolve(this.configState(GSheetsConfig, this.config))
  }
}
