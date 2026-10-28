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

export const INT_COMPARATORS: ReadonlyMap<string, (li: bigint, ri: bigint) => boolean> = new Map([
  ['-eq', (li: bigint, ri: bigint) => li === ri],
  ['-ne', (li: bigint, ri: bigint) => li !== ri],
  ['-lt', (li: bigint, ri: bigint) => li < ri],
  ['-le', (li: bigint, ri: bigint) => li <= ri],
  ['-gt', (li: bigint, ri: bigint) => li > ri],
  ['-ge', (li: bigint, ri: bigint) => li >= ri],
])

const STRING_BINARY = new Set(['=', '==', '!=', '<', '>'])
const NUMERIC_BINARY = new Set(INT_COMPARATORS.keys())
// `-nt`/`-ot` compare modification times; `-ef` asks for the same file,
// which mirage answers as the same resolved path (a mount has no device or
// inode to compare, and one path names one entry).
export const FILE_PAIR_BINARY = new Set(['-nt', '-ot', '-ef'])
const STRING_UNARY = new Set(['-n', '-z'])
// `-v NAME` asks whether the variable (or the `NAME[sub]` element) is set
// and `-R NAME` whether it is a nameref aimed at a name; `-o OPT` whether a
// `set -o` option is on, and `-t FD` whether a descriptor is a terminal.
// They read session state, not a path.
const SESSION_UNARY = new Set(['-v', '-R', '-o', '-t'])
// `-a` is bash's old spelling of `-e`. Mirage keeps one user who owns every
// entry it reaches (`-O`, `-G`), modes only where a store keeps them (`-u`,
// `-g`, `-k`), and no socket or block device (`-S`, `-b`).
export const FILE_UNARY = new Set([
  '-a',
  '-e',
  '-f',
  '-d',
  '-c',
  '-p',
  '-b',
  '-S',
  '-s',
  '-r',
  '-w',
  '-x',
  '-u',
  '-g',
  '-k',
  '-O',
  '-G',
  '-N',
  '-L',
  '-h',
])
export const BINARY_OPS = new Set([...STRING_BINARY, ...NUMERIC_BINARY, ...FILE_PAIR_BINARY])
export const UNARY_OPS = new Set([...STRING_UNARY, ...SESSION_UNARY, ...FILE_UNARY])
