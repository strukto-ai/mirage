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

import type { RowActionKind } from './types.ts'
import { sizeSuffixes } from './utils/size_suffix.ts'

export enum PatternType {
  EXACT = 'exact',
  SIMPLE = 'simple',
  REGEX = 'regex',
}

// Extensions a recursive grep skips without reading. Two families, and
// the second is load-bearing for any remote mount: the columnar formats
// were here first, and the model-weight formats joined them because a
// `grep -r` over a Hugging Face model repo otherwise downloads every
// checkpoint in it to search bytes that cannot contain a text match --
// 41 GB of transfer for one grep of openai/gpt-oss-20b. GNU has no such
// list (it sniffs the bytes it has already read off local disk), so this
// is a deliberate divergence that only costs a network fetch, and `-a`
// turns it off exactly as GNU's own binary handling does.
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.parquet',
  '.orc',
  '.feather',
  '.arrow',
  '.ipc',
  '.hdf5',
  '.h5',
  '.safetensors',
  '.gguf',
  '.ggml',
  '.bin',
  '.pt',
  '.pth',
  '.ckpt',
  '.onnx',
  '.npy',
  '.npz',
  '.msgpack',
  '.tflite',
  '.pb',
  '.model',
])

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

// od, split and cmp all read their counts with xstrtoumax, which skips leading
// whitespace and allows one '+' before the digits, so `-b +10` and `-b " 10"`
// are valid while `+ 10`, `++10`, `-10` and a trailing space are not.
// A bigint: as a double, 2 ** 64 - 1 rounds up to 2 ** 64, which would let
// exactly-2**64 values through the too-large checks that python rejects.
export const UINTMAX = 2n ** 64n - 1n
export const INTMAX = 2n ** 63n - 1n

export const OD_SIZE_UNITS = sizeSuffixes('bkKmMGTPE')
// Q/R/Y/Z are in GNU od's suffix set but always overflow uintmax, so they
// report as too-large rather than as unknown suffixes.
export const OD_OVERFLOW_UNITS = sizeSuffixes('QRYZ')
// strtoumax base 0: after the whitespace and sign above, 0x… is hex, a leading
// 0 is octal, else decimal; the unconsumed remainder is the suffix. The sign
// stays outside group 1 so the radix is picked from the digits alone
// (`-N +0x10` is hex, `-N +010` is octal).
export const XSTRTOUMAX_PATTERN = /^[ \t\n\v\f\r]*\+?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)(.*)$/

// GNU cmp (diffutils 3.10) shares od's grammar above but not its letter set:
// no b/c/w, lowercase only up to k, and its gnulib predates Q/R, so `0Q`
// is an invalid value where `0Z` is a valid zero. Its ceiling is INTMAX, not
// UINTMAX, and an overflowing value reports as the same "invalid ... value"
// as a bad suffix rather than as too-large.
export const CMP_SIZE_UNITS = sizeSuffixes('kKMGTPEZY')

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

// GNU answers a missing script with its whole thirty-nine line usage block
// and exit 1; mirage names the problem in one line instead, because the
// block is GNU's own prose and reproducing it buys a mirage user nothing.
// `no input files` and its exit 4 are GNU's exact spelling for `sed -i`
// with no operands, and mirage reuses them when there is no stdin either --
// it has no terminal for GNU's blocking read to reach. Both live here so
// the generic and its builder cannot drift apart again; there used to be
// four spellings across the two languages.
export const SED_MISSING_SCRIPT = 'sed: missing script'
export const SED_NO_INPUT_FILES = 'sed: no input files'
export const SED_NO_INPUT_EXIT = 4

// The word an `-exec` argument that stands for the match is spelled as.
export const EXEC_PLACEHOLDER = '{}'
// The two terminators of an `-exec` argument list: `;` ends a per-match
// run, `+` ends a batched run and only when it follows a word holding `{}`.
export const EXEC_END = ';'
export const EXEC_BATCH_END = '+'

export const FIND_VALUE_PREDICATES = new Set([
  '-name',
  '-iname',
  '-path',
  '-type',
  '-size',
  '-mtime',
  '-maxdepth',
  '-mindepth',
  '-printf',
  '-newer',
  '-newermt',
])

// `-exec` takes every word up to its terminator, so it is neither a value
// predicate nor a bare one.
export const FIND_EXEC_PREDICATES = new Set(['-exec'])

export const FIND_BARE_PREDICATES = new Set([
  '-empty',
  '-print',
  '-print0',
  '-delete',
  '-ls',
  '-depth',
])

export const FIND_OPERATORS = new Set(['-not', '!', '-o', '-or', '-a', '-and', '(', ')'])

export const FIND_EXPRESSION_TOKENS: ReadonlySet<string> = new Set([
  ...FIND_VALUE_PREDICATES,
  ...FIND_BARE_PREDICATES,
  ...FIND_OPERATORS,
  ...FIND_EXEC_PREDICATES,
])

export const FIND_VALID_TYPES: ReadonlySet<string> = new Set(['b', 'c', 'd', 'p', 'f', 'l', 's'])

export const FIND_MAX_DEPTH = 100

export const FIND_ROW_ACTIONS: ReadonlyMap<string, RowActionKind> = new Map([
  ['-print', 'print'],
  ['-print0', 'print0'],
  ['-ls', 'ls'],
  ['-delete', 'delete'],
])
