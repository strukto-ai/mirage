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

import type { MachineAccessor } from '../../accessor/machine.ts'
import type { PathSpec } from '../../types.ts'
import { singleQuote } from '../../utils/quote.ts'
import { COPIED } from '../posix/constants.ts'
import { copyTreeCommand } from '../posix/copy.ts'
import { refusal } from '../posix/errors.ts'
import { checked, remote } from './utils.ts'

/**
 * Copy a file on one machine.
 *
 * @param accessor the mount's machines.
 * @param machine the machine both names are on.
 * @param src the source.
 * @param dst the copy.
 */
export async function copy(
  accessor: MachineAccessor,
  machine: string,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  const old = singleQuote(remote(accessor, src))
  const fresh = singleQuote(remote(accessor, dst))
  await checked(accessor, machine, `cp -T -- ${old} ${fresh}`, dst)
}

/**
 * Copy a directory tree on one machine with one `cp -RL`.
 *
 * @param accessor the mount's machines.
 * @param machine the machine both names are on.
 * @param src the directory.
 * @param dst the copy.
 */
export async function dirCopy(
  accessor: MachineAccessor,
  machine: string,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  const [status, out, err] = await accessor.run(
    machine,
    copyTreeCommand(remote(accessor, src), remote(accessor, dst)),
  )
  if (status !== 0 || new TextDecoder().decode(out) !== COPIED) throw refusal(dst, err)
}
