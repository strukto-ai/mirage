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
import { enotsup } from '../../errors/fs.ts'
import { chunks } from '../../io/cooperative.ts'
import { closeQuietly } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import { record, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { singleQuote } from '../../utils/quote.ts'
import { runChecked, machinePath } from './utils.ts'

/**
 * The line that writes what it is fed to a file: in place, at its end, or
 * onto a sibling name renamed over it once the input ends, so nothing shows
 * a half-written file and nothing is left behind.
 *
 * @param target the file's path on the machine.
 * @param append add to the end instead of replacing.
 * @param atomic show nothing until the input has ended whole.
 */
export function writeCommand(target: string, append: boolean, atomic: boolean): string {
  const q = singleQuote(target)
  if (append) return `cat >> ${q}`
  if (!atomic) return `cat > ${q}`
  const staged = singleQuote(`${target}.mirage-${crypto.randomUUID().replaceAll('-', '')}`)
  return `cat > ${staged} && mv -f -- ${staged} ${q} || { rm -f -- ${staged}; exit 1; }`
}

/**
 * Write a file on a machine, the bytes streamed to its `cat`. A machine
 * whose exec takes no input (Daytona) refuses the write.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the file.
 * @param data the bytes, consumed once.
 * @param append add them to the end instead.
 * @param atomic show nothing until the stream has ended whole.
 */
export async function write(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  data: ByteSource,
  append = false,
  atomic = false,
): Promise<void> {
  if (!accessor.handle(machine).takesInput) {
    await closeQuietly(data)
    throw enotsup('machine', append ? 'append' : 'write', path)
  }
  const timer = startOp()
  let size = 0
  async function* counted(): AsyncIterable<Uint8Array> {
    for await (const part of chunks(data)) {
      size += part.byteLength
      yield part
    }
  }
  try {
    const command = writeCommand(machinePath(accessor, path), append, atomic)
    await runChecked(accessor, machine, command, path, counted())
  } finally {
    await closeQuietly(data)
  }
  record(append ? 'append' : 'write', path.virtual, VFSName.MACHINE, size, timer)
}
