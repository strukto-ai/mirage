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

import { sizeSuffixes } from './utils/size_suffix.ts'

export enum PatternType {
  EXACT = 'exact',
  SIMPLE = 'simple',
  REGEX = 'regex',
}

// GNU `file -i` reports a symlink by its inode type, never by whatever
// the target would have sniffed as.
export const MIME_SYMLINK = 'inode/symlink; charset=binary'

export const FILE_MIME_MAP: Readonly<Record<string, string>> = Object.freeze({
  text: 'text/plain; charset=us-ascii',
  json: 'application/json; charset=us-ascii',
  csv: 'text/csv; charset=us-ascii',
  directory: 'inode/directory',
  binary: 'application/octet-stream',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'application/zip': 'application/zip',
  'application/gzip': 'application/gzip',
  'application/pdf': 'application/pdf',
})

// od and split both read their counts with xstrtoumax, which skips leading
// whitespace and allows one '+' before the digits, so `-b +10` and `-b " 10"`
// are valid while `+ 10`, `++10`, `-10` and a trailing space are not.
// A bigint: as a double, 2 ** 64 - 1 rounds up to 2 ** 64, which would let
// exactly-2**64 values through the too-large checks that python rejects.
export const UINTMAX = 2n ** 64n - 1n

export const OD_SIZE_UNITS = sizeSuffixes('bkKmMGTPE')
// Q/R/Y/Z are in GNU od's suffix set but always overflow uintmax, so they
// report as too-large rather than as unknown suffixes.
export const OD_OVERFLOW_UNITS = sizeSuffixes('QRYZ')
// strtoumax base 0: after the whitespace and sign above, 0x… is hex, a leading
// 0 is octal, else decimal; the unconsumed remainder is the suffix. The sign
// stays outside group 1 so the radix is picked from the digits alone
// (`-N +0x10` is hex, `-N +010` is octal).
export const OD_COUNT_PATTERN = /^[ \t\n\v\f\r]*\+?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)(.*)$/

// GNU split's letter set: every uppercase power letter plus b, and lowercase
// k/m only (pinned against coreutils 9.7). Unlike od, split is base-10 only:
// hex and octal spellings are invalid numbers.
export const SPLIT_BYTE_UNITS = sizeSuffixes('bkKmMEGPQRTYZ')
export const SPLIT_BYTE_SUFFIXES = Object.keys(SPLIT_BYTE_UNITS).sort((a, b) => b.length - a.length)
export const SPLIT_COUNT_PATTERN = /^[ \t\n\v\f\r]*\+?[0-9]+$/
// Suffix start values are the exception to the grammar above: coreutils 9.7
// rejects both `--numeric-suffixes=+5` and `=" 5"`, so they keep the strict
// digits-only form.
export const SPLIT_DIGITS = /^[0-9]+$/
export const SPLIT_HEX_DIGITS = /^[0-9a-fA-F]+$/
export const SPLIT_TRY_HELP = "\nTry 'split --help' for more information."
