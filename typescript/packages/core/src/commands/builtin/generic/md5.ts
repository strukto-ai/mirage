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

import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import { stdinStream } from '../utils/stream.ts'
import { hashOperands, type StoredDigest } from './checksum.ts'

function md5Line(digest: string, label: string): string {
  return `${digest}  ${label}\n`
}

/**
 * Run BSD md5 over resolved operands. An operand's digest is asked of
 * `stored` first, once `stat` has found a file there, and the file is read
 * only when there is none. Mirrors Python's md5_generic.
 */
export async function md5Generic(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  stat?: (p: PathSpec) => Promise<unknown>,
  stored?: StoredDigest,
): Promise<CommandFnResult> {
  return hashOperands(
    paths.length > 0 ? paths : [STDIN_OPERAND],
    paths.length > 0 ? stream : stdinStream(stream, opts.stdin),
    'md5',
    'md5',
    md5Line,
    stat,
    stored,
  )
}
