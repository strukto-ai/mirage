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

import { FileType, PathSpec } from '../../../types.ts'

export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

export const EPOCH_LS_TIME = 'Jan  1 00:00'

// GNU's simple-backup suffix (mv/cp -b), overridable with -S.
export const DEFAULT_BACKUP_SUFFIX = '~'

export const CHAR_DEVICE_MAX_BYTES = 8 << 20

// GNU's name for stdin: head and tail's `==> name <==` header, and the
// checksum list a `*sum -c` diagnostic names.
export const STDIN_HEADER_NAME = 'standard input'

// grep's name for stdin in a match prefix or diagnostic, unless --label
// names another.
export const GREP_STDIN_LABEL = '(standard input)'

// How long curl and wget wait on a request when the line sets no limit
// of its own.
export const HTTP_TIMEOUT_SECONDS = 30

// The operand a command reads stdin through when the line names none.
export const STDIN_OPERAND = new PathSpec({ virtual: '-', directory: '-', vfsPath: '-' })

export const TYPE_CHARS: Partial<Record<FileType, string>> = {
  [FileType.DIRECTORY]: 'd',
  [FileType.SYMLINK]: 'l',
  [FileType.CHAR_DEVICE]: 'c',
  [FileType.BLOCK_DEVICE]: 'b',
  [FileType.FIFO]: 'p',
  [FileType.SOCKET]: 's',
}

// GNU ls's window of "recent" times: half a Gregorian year of 365.2425
// days, in seconds. GNU find -ls draws its own line: old past 180 days,
// future past an hour.
export const LS_RECENT_SECONDS = Math.floor(31556952 / 2)
export const FIND_OLD_SECONDS = 180 * 24 * 60 * 60
export const FIND_FUTURE_SECONDS = 60 * 60

// How `find -ls` spells a name: findutils escapes these so the row stays
// one line and re-parseable.
export const FIND_LS_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  ' ': '\\ ',
  '"': '\\"',
  '\n': '\\n',
  '\t': '\\t',
  '\r': '\\r',
  '\x07': '\\a',
  '\b': '\\b',
  '\f': '\\f',
  '\v': '\\v',
}
