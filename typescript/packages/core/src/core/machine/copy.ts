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
 * A copy's line, the new name's folder made first when asked.
 *
 * @param line the copy.
 * @param target the new name's path on the machine.
 * @param makeParent make its folder there first.
 */
function inFolder(line: string, target: string, makeParent: boolean): string {
  if (!makeParent) return line
  const cut = target.lastIndexOf('/')
  const parent = cut > 0 ? target.slice(0, cut) : '/'
  return `mkdir -p -- ${singleQuote(parent)} && ${line}`
}

/**
 * Copy a file on the source's machine.
 *
 * @param accessor the mount's machines.
 * @param machine the source's machine.
 * @param src the source.
 * @param dst the copy.
 * @param makeParent make the copy's folder there first, when only another
 *   machine holds it.
 */
export async function copy(
  accessor: MachineAccessor,
  machine: string,
  src: PathSpec,
  dst: PathSpec,
  makeParent = false,
): Promise<void> {
  const old = singleQuote(remote(accessor, src))
  const fresh = remote(accessor, dst)
  const line = inFolder(`cp -T -- ${old} ${singleQuote(fresh)}`, fresh, makeParent)
  await checked(accessor, machine, line, dst)
}

/**
 * Copy a directory tree onto a fresh name on the source's machine, with
 * one `cp -RL`.
 *
 * @param accessor the mount's machines.
 * @param machine the source's machine.
 * @param src the directory.
 * @param dst the copy.
 * @param makeParent make the copy's folder there first, when only another
 *   machine holds it.
 */
export async function dirCopy(
  accessor: MachineAccessor,
  machine: string,
  src: PathSpec,
  dst: PathSpec,
  makeParent = false,
): Promise<void> {
  const fresh = remote(accessor, dst)
  const line = inFolder(copyTreeCommand(remote(accessor, src), fresh), fresh, makeParent)
  const [status, out, err] = await accessor.run(machine, line)
  if (status !== 0 || new TextDecoder().decode(out) !== COPIED) throw refusal(dst, err)
}
