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
import { COPIED } from '@struktoai/mirage-core/core/posix/constants'
import { copyTreeCommand } from '@struktoai/mirage-core/core/posix/copy'
import { refusal } from '@struktoai/mirage-core/core/posix/errors'
import { joinRoot } from '@struktoai/mirage-core/core/posix/utils'
import { enotsup } from '@struktoai/mirage-core/errors/fs'
import { liftLost, lostCount, record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName, type PathSpec } from '@struktoai/mirage-core/types'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { exists } from './exists.ts'
import { read } from './read.ts'
import { write } from './write.ts'

export async function copy(accessor: SSHAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const data = await read(accessor, src)
  await write(accessor, dst, data)
}

/**
 * Copy a directory tree onto a fresh name with one `cp -RL` on the server,
 * which follows links as the mount's listing does. A server that runs no
 * commands leaves nothing at `dst`: that is ENOTSUP, and `cp -r` walks the
 * tree itself. Mirrors Python's `dir_copy`.
 */
export async function dirCopy(accessor: SSHAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const root = accessor.config.root ?? '/'
  const command = copyTreeCommand(joinRoot(root, rawPathOf(src)), joinRoot(root, rawPathOf(dst)))
  const upto = lostCount()
  const timer = startOp()
  let status: number | null
  let out: Uint8Array
  let err: Uint8Array
  try {
    ;[status, out, err] = await accessor.run(command)
  } catch (error) {
    console.debug(`ssh tree copy left to the walk: ${String(error)}`)
    throw enotsup(VFSName.SSH, 'dirCopy', dst)
  }
  if (status === 0 && new TextDecoder().decode(out) === COPIED) {
    record('copy_prefix', dst.virtual, VFSName.SSH, 0, timer)
    liftLost(dst, upto, true)
    return
  }
  if (!(await exists(accessor, dst))) {
    console.debug(`ssh tree copy left to the walk: ${new TextDecoder().decode(err)}`)
    throw enotsup(VFSName.SSH, 'dirCopy', dst)
  }
  throw refusal(dst, err)
}
