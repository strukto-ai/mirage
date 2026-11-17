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

import { fsError } from '../../errors/fs.ts'
import { POSIX } from '../../errors/posix.ts'
import type { FsCondition, FsError } from '../../errors/types.ts'
import type { PathSpec } from '../../types.ts'
import { SHELL_PHRASES } from './constants.ts'

/**
 * The error a POSIX tool that ran and failed reports, by the phrase its
 * first complaint ends with (`mv: cannot stat 'a': No such file or
 * directory`), or a shell's own wording of one (`SHELL_PHRASES`); anything
 * else is EIO.
 *
 * @param path the path the error names.
 * @param err what the tool wrote to its error output.
 */
export function refusal(path: PathSpec, err: Uint8Array): FsError {
  const first = new TextDecoder().decode(err).trim().split('\n')[0] ?? ''
  for (const [condition, posix] of Object.entries(POSIX)) {
    if (first.endsWith(`: ${posix.phrase}`)) return fsError(path, condition as FsCondition)
  }
  for (const [phrase, said] of Object.entries(SHELL_PHRASES)) {
    if (first.endsWith(`: ${phrase}`)) return fsError(path, said)
  }
  return fsError(path, 'EIO')
}
