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
import { record, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { singleQuote } from '../../utils/quote.ts'
import { refusal } from '../posix/errors.ts'
import { lineCount as posixLineCount } from '../posix/read.ts'
import { runChecked, machinePath } from './utils.ts'

/**
 * The line that prints a file's bytes from `offset`, `size` of them or all.
 *
 * @param target the file's path on the machine.
 * @param offset the first byte.
 * @param size how many bytes; null for the rest.
 */
export function readCommand(target: string, offset: number, size: number | null): string {
  const q = singleQuote(target)
  if (offset !== 0 && size !== null)
    return `tail -c +${String(offset + 1)} -- ${q} | head -c ${String(size)}`
  if (offset !== 0) return `tail -c +${String(offset + 1)} -- ${q}`
  if (size !== null) return `head -c ${String(size)} -- ${q}`
  return `cat -- ${q}`
}

/**
 * A file's bytes on its machine, a window of them or all.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the file.
 * @param offset the first byte.
 * @param size how many bytes; null for the rest.
 */
export async function read(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  offset = 0,
  size: number | null = null,
): Promise<Uint8Array> {
  const timer = startOp()
  const data = await runChecked(
    accessor,
    machine,
    readCommand(machinePath(accessor, path), offset, size),
    path,
    null,
    true,
  )
  record('read', path.virtual, VFSName.MACHINE, data.byteLength, timer)
  return data
}

/**
 * A whole file's bytes on its machine, handed over as they are read and
 * never held whole, so a file of any size goes to a store in the memory of
 * a few chunks.
 *
 * @param accessor the mount's machines.
 * @param machine the machine holding the file.
 * @param path the file.
 * @param signal stops the read, one waiting on the machine included.
 */
export async function* readStream(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const timer = startOp()
  let sent = 0
  for await (const chunk of accessor.stream(
    machine,
    readCommand(machinePath(accessor, path), 0, null),
    (_status, err) => refusal(path, err),
    signal,
  )) {
    sent += chunk.byteLength
    yield chunk
  }
  record('read', path.virtual, VFSName.MACHINE, sent, timer)
}

/**
 * A file's first `n` lines, by `head` on its machine.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the file.
 * @param n how many lines.
 */
export function firstLines(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  n: number,
): Promise<Uint8Array> {
  const target = singleQuote(machinePath(accessor, path))
  return runChecked(accessor, machine, `head -n ${String(n)} -- ${target}`, path, null, true)
}

/**
 * A file's last `n` lines, by `tail` on its machine.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the file.
 * @param n how many lines.
 */
export function lastLines(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  n: number,
): Promise<Uint8Array> {
  const target = singleQuote(machinePath(accessor, path))
  return runChecked(accessor, machine, `tail -n ${String(n)} -- ${target}`, path, null, true)
}

/**
 * How many newlines a file holds, by `wc` on its machine.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the file.
 */
export function lineCount(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
): Promise<number | null> {
  return posixLineCount(accessor.runner(machine), machinePath(accessor, path))
}
