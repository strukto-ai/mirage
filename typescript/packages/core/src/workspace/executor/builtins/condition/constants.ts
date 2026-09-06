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

const STRING_BINARY = new Set(['=', '==', '!='])
const NUMERIC_BINARY = new Set(INT_COMPARATORS.keys())
// `-nt`/`-ot` compare modification times; `-ef` asks for the same file,
// which mirage answers as the same resolved path (a mount has no device or
// inode to compare, and one path names one entry).
export const FILE_PAIR_BINARY = new Set(['-nt', '-ot', '-ef'])
const STRING_UNARY = new Set(['-n', '-z'])
// `-v NAME` asks whether the variable (or the `NAME[sub]` element) is
// set; it reads session state, not a path.
const VAR_UNARY = new Set(['-v'])
export const FILE_UNARY = new Set(['-e', '-f', '-d', '-c', '-s', '-r', '-w', '-x', '-L', '-h'])
// Real GNU operators mirage cannot answer truthfully: the VFS has no
// FIFO/socket/device node types, no uid/gid ownership or setuid bits,
// and no controlling terminal. Failing loudly beats the silent-false
// this module used to produce.
export const UNSUPPORTED_UNARY = new Set([
  '-p',
  '-S',
  '-b',
  '-g',
  '-k',
  '-u',
  '-O',
  '-G',
  '-N',
  '-t',
])
export const BINARY_OPS = new Set([...STRING_BINARY, ...NUMERIC_BINARY, ...FILE_PAIR_BINARY])
export const UNARY_OPS = new Set([
  ...STRING_UNARY,
  ...VAR_UNARY,
  ...FILE_UNARY,
  ...UNSUPPORTED_UNARY,
])
