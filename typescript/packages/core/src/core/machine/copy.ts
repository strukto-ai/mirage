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
import { inFolder, runChecked, machinePath } from './utils.ts'

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
  await copyFrom(accessor, accessor, machine, src, dst, makeParent)
}

/**
 * Copy a file another machine mount shows onto this one, on the machine
 * holding it, which both mounts show: the bytes stay there.
 *
 * @param source the source mount's machines.
 * @param accessor this mount's machines.
 * @param machine the source's machine.
 * @param src the source, on its mount.
 * @param dst the copy, on this mount.
 * @param makeParent make the copy's folder there first, when only another
 *   machine holds it.
 */
export async function copyFrom(
  source: MachineAccessor,
  accessor: MachineAccessor,
  machine: string,
  src: PathSpec,
  dst: PathSpec,
  makeParent = false,
): Promise<void> {
  const old = singleQuote(machinePath(source, src))
  const fresh = machinePath(accessor, dst)
  const line = inFolder(`cp -T -- ${old} ${singleQuote(fresh)}`, fresh, makeParent)
  await runChecked(accessor, machine, line, dst)
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
  const fresh = machinePath(accessor, dst)
  const line = inFolder(copyTreeCommand(machinePath(accessor, src), fresh), fresh, makeParent)
  const [status, out, err] = await accessor.run(machine, line)
  if (status !== 0 || new TextDecoder().decode(out) !== COPIED) throw refusal(dst, err)
}
