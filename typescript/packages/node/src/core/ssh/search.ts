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

import type { PathSpec } from '@struktoai/mirage-core/types'
import { filesContaining as posixFilesContaining } from '@struktoai/mirage-core/core/posix/search'
import type { SSHAccessor } from '../../accessor/ssh.ts'

/**
 * The files under `under` whose bytes hold `text`, as grep on the server
 * finds them.
 *
 * The answer is exact, since every file is searched, so a whole word is asked
 * as plain text: a file the word only sits inside is one more read. Only an
 * exit of 0 or 1 with nothing on stderr, and output that is NUL-ended names,
 * answers: a server that runs no commands (one forced to internal-sftp says
 * so on stdout and exits 1), a grep that refuses an option (busybox exits 1
 * for one), or a file it could not read (which the walk then reports) leaves
 * every file to be read. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: SSHAccessor,
  text: string,
  under: PathSpec[],
  ignoreCase: boolean,
): Promise<PathSpec[] | null> {
  try {
    return await posixFilesContaining(
      (command) => accessor.run(command),
      accessor.config.root ?? '/',
      text,
      under,
      ignoreCase,
    )
  } catch (error) {
    console.debug(`ssh search left to the scan: ${String(error)}`)
    return null
  }
}
