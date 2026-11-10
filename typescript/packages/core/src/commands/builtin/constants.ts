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

// The bytes C `isspace` accepts, which every gnulib scanner skips before
// the sign. Spelled out rather than written `\s`: JavaScript's `\s` also
// matches every Unicode space and python's matches 0x1c-0x1f, and GNU
// refuses both, so a shorthand would accept more than the C library does.
export const C_SPACE = '[ \\t\\n\\v\\f\\r]*'

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
// The heads of gzip -l's table, plain and under -v, and the width of the
// method, CRC and date columns -v puts before the totals row's numbers.
export const GZIP_LIST_HEAD = '         compressed        uncompressed  ratio uncompressed_name'
export const GZIP_LIST_VERBOSE_HEAD =
  'method  crc     date  time           compressed        uncompressed  ratio uncompressed_name'
export const GZIP_LIST_VERBOSE_INDENT = 28

export const AWK_USAGE = "awk: usage: awk [-F fs] [-v var=val] 'program' [file ...]"

// The word an `-exec` argument that stands for the match is spelled as.
export const EXEC_PLACEHOLDER = '{}'

// How many of one command's operands are in flight at once: the per-mount
// runs of a cross-mount line, or the stats a command takes before it reads.
export const OPERAND_CONCURRENCY = 4

// Where mktemp creates a name when neither -p nor TMPDIR says.
export const FALLBACK_TMPDIR = '/tmp'

// The one name every host answers with; hostname and uname -n print it.
export const HOSTNAME = 'mirage'
// The processors the workspace itself has: a session runs its lines one at a
// time, and no host detail leaks.
export const CPUS = 1
export const MACHINE = 'x86_64'
