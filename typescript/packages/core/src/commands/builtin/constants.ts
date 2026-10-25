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

import type { RowActionKind } from '../../core/generic/find_eval.ts'
import { sizeSuffixes } from './utils/size_suffix.ts'
import { ContentType } from '../../types.ts'

export enum PatternType {
  EXACT = 'exact',
  SIMPLE = 'simple',
  REGEX = 'regex',
}

// GNU `file -i` reports a symlink by its inode type, never by whatever
// the target would have sniffed as.
export const MIME_SYMLINK = 'inode/symlink; charset=binary'

// How much of a file `file` sniffs: only its first bytes are read.
export const FILE_HEADER_BYTES = 512

// The leading bytes `file` recognizes a format by, checked in order.
export const MAGIC_SIGNATURES: readonly (readonly [readonly number[], ContentType])[] = [
  [[0x89, 0x50, 0x4e, 0x47], ContentType.IMAGE_PNG],
  [[0xff, 0xd8, 0xff], ContentType.IMAGE_JPEG],
  [[0x47, 0x49, 0x46, 0x38], ContentType.IMAGE_GIF],
  [[0x50, 0x4b, 0x03, 0x04], ContentType.ZIP],
  [[0x1f, 0x8b], ContentType.GZIP],
  [[0x25, 0x50, 0x44, 0x46], ContentType.PDF],
  [[0x7b, 0x0a], ContentType.JSON],
  [[0x5b, 0x7b], ContentType.JSON],
]

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

// od, split and cmp all skip leading whitespace in a count and allow one '+'
// before the digits, so `-b +10` and `-b " 10"` are valid while `+ 10`,
// `++10`, `-10` and a trailing space are not.
// A bigint: as a double, 2 ** 64 - 1 rounds up to 2 ** 64, which would let
// exactly-2**64 values through the too-large checks that python rejects.
export const UINTMAX = 2n ** 64n - 1n
export const INTMAX = 2n ** 63n - 1n

// gnulib appends strerror(EOVERFLOW) when a value did not fit the type it was
// scanned into. Measured under LC_ALL=C on glibc; the string here most likely
// to read differently under another libc or locale.
export const EOVERFLOW_TEXT = 'Value too large for defined data type'

// The bytes C `isspace` accepts, which every gnulib scanner skips before
// the sign. Spelled out rather than written `\s`: JavaScript's `\s` also
// matches every Unicode space and python's matches 0x1c-0x1f, and GNU
// refuses both, so a shorthand would accept more than the C library does.
export const C_SPACE = '[ \\t\\n\\v\\f\\r]*'

// strtoumax base 0: after the whitespace and sign above, 0x… is hex, a leading
// 0 is octal, else decimal; the unconsumed remainder is the suffix. The sign
// stays outside group 1 so the radix is picked from the digits alone
// (`-N +0x10` is hex, `-N +010` is octal).
export const SUFFIXED_COUNT_PATTERN = new RegExp(
  `^${C_SPACE}\\+?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)(.*)$`,
)

// GNU cmp (diffutils 3.10) shares od's grammar above but not its letter set:
// no b/c/w, lowercase only up to k, and its gnulib predates Q/R, so `0Q`
// is an invalid value where `0Z` is a valid zero. Its ceiling is INTMAX, not
// UINTMAX, and an overflowing value reports as the same "invalid ... value"
// as a bad suffix rather than as too-large.
export const CMP_SIZE_UNITS = sizeSuffixes('kKMGTPEZY')

// gzip 1.13's file naming. The suffix gzip writes and looks for unless -S
// names another; the suffixes it always recognizes on a name it
// decompresses, compared without regard to ASCII case; the ones it tries in
// turn on a name that does not exist, the -S suffix first; and the longest
// -S suffix it accepts, in bytes.
export const GZIP_SUFFIX = '.gz'
export const GZIP_KNOWN_SUFFIXES = ['.gz', '.z', '.taz', '.tgz', '-gz', '-z', '_z'] as const
export const GZIP_RETRY_SUFFIXES = ['.gz', '.z', '-z', '.Z'] as const
// The suffixes gzip -d turns into .tar rather than dropping.
export const GZIP_TAR_SUFFIXES = ['.tgz', '.taz'] as const
export const GZIP_MAX_SUFFIX = 30

// GNU answers a missing script with its whole thirty-nine line usage block
// and exit 1; mirage names the problem in one line instead, because the
// block is GNU's own prose and reproducing it buys a mirage user nothing.
export const SED_MISSING_SCRIPT = 'sed: missing script'

export const AWK_USAGE = "awk: usage: awk [-F fs] [-v var=val] 'program' [file ...]"

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
  '-xdev',
  '-mount',
  '-prune',
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

// How many per-mount runs of one cross-mount line are in flight at once.
export const OPERAND_CONCURRENCY = 4

// Where mktemp creates a name when neither -p nor TMPDIR says.
export const FALLBACK_TMPDIR = '/tmp'

// The status of a command SIGPIPE ended, as a shell reports it (128 + 13).
export const SIGPIPE_EXIT = 141

// The one name every host answers with; hostname and uname -n print it.
export const HOSTNAME = 'mirage'
