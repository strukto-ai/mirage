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

import type { RegexSyntax } from './types.ts'
import type { WalkFilters } from './grep_select.ts'

export interface FlagSet {
  filters: WalkFilters
  binaryMode: string
  recursive: boolean
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  byteOffsets: boolean
  countOnly: boolean
  filesOnly: boolean
  filesWithoutMatch: boolean
  wholeWord: boolean
  lineRegexp: boolean
  fixedString: boolean
  syntax: RegexSyntax
  onlyMatching: boolean
  maxCount: number | null
  quiet: boolean
  noMessages: boolean
  withFilename: boolean
  noFilename: boolean
  afterContext: number | null
  beforeContext: number | null
  skipDirectories?: boolean
  skipDevices?: boolean
  nullData?: boolean
  null?: boolean
  initialTab?: boolean
  groupSeparator?: string | null
  label?: string
  dereference?: boolean
}

// GNU grep's INITIAL_BUFSIZE: the window it examines before printing from it.
export const PROBE_BLOCK_BYTES = 96 * 1024

/**
 * The line grep prints between two context groups, or nothing. GNU separates
 * groups once -A, -B or -C is given, zero included and under -o too (grep
 * 3.11: `grep -A0` prints `--` between two lines that are not neighbours);
 * -c, -l, -L and -q print no lines.
 */
export function groupLine(f: FlagSet): string {
  if (f.countOnly || f.filesOnly || f.filesWithoutMatch || f.quiet) return ''
  const separator = f.groupSeparator === undefined ? '--' : f.groupSeparator
  if (separator === null || (f.afterContext === null && f.beforeContext === null)) return ''
  return separator + '\n'
}

/** What follows a file name -l or -L prints: NUL under -Z. */
export function nameEnd(f: FlagSet): string {
  return f.null === true ? '\0' : '\n'
}

/** Whether every byte of `data` belongs to a UTF-8 character. */
export function validUtf8(data: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return true
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return false
  }
}
