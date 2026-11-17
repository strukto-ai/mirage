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

import { rawPathOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { checksum as posixChecksum } from '@struktoai/mirage-core/core/posix/checksum'
import { joinRoot } from '@struktoai/mirage-core/core/posix/utils'
import type { SSHAccessor } from '../../accessor/ssh.ts'

/**
 * A file's digest, by the matching coreutils sum on the server, so the bytes
 * never cross the connection.
 *
 * Only an exit of 0 with nothing on stderr and one digest of the algorithm's
 * length on stdout answers: a server that runs no commands or has no such
 * tool, a directory or a file the tool could not read leaves the file to be
 * read and hashed, which reports it. Mirrors Python's `checksum`.
 */
export async function checksum(
  accessor: SSHAccessor,
  p: PathSpec,
  algorithm: string,
): Promise<string | null> {
  const remote = joinRoot(accessor.config.root ?? '/', rawPathOf(p))
  try {
    return await posixChecksum((command) => accessor.run(command), remote, algorithm)
  } catch (error) {
    console.debug(`ssh checksum left to the read: ${String(error)}`)
    return null
  }
}
