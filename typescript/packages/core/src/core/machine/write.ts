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
import { chunks } from '../../io/cooperative.ts'
import { closeQuietly } from '../../io/stream.ts'
import { materialize, type ByteSource } from '../../io/types.ts'
import { record, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { concat } from '../../utils/bytes.ts'
import { singleQuote } from '../../utils/quote.ts'
import { refusal } from '../posix/errors.ts'
import { checked, remote } from './utils.ts'

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
 * Write a file whole through the machine's file API, from what `change`
 * makes of its bytes (none for a missing file): how a machine whose exec
 * takes no input (Daytona) appends and writes at an offset.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the file.
 * @param change the new bytes from the old.
 */
export async function rewrite(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  change: (old: Uint8Array) => Uint8Array,
): Promise<void> {
  const target = remote(accessor, path)
  const q = singleQuote(target)
  const old = await checked(accessor, machine, `[ ! -e ${q} ] || cat -- ${q}`, path)
  const done = await accessor.handle(machine).putFile(target, change(old))
  if (done.exitCode !== 0) throw refusal(path, done.stderr.length > 0 ? done.stderr : done.stdout)
}

/**
 * Write a file on a machine, the bytes streamed to its `cat`.
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
  const timer = startOp()
  let size = 0
  async function* counted(): AsyncIterable<Uint8Array> {
    for await (const part of chunks(data)) {
      size += part.byteLength
      yield part
    }
  }
  try {
    if (accessor.handle(machine).takesInput) {
      const command = writeCommand(remote(accessor, path), append, atomic)
      await checked(accessor, machine, command, path, counted())
    } else {
      const body = await materialize(data)
      size = body.byteLength
      await rewrite(accessor, machine, path, (old) => (append ? concat([old, body]) : body))
    }
  } finally {
    await closeQuietly(data)
  }
  record(append ? 'append' : 'write', path.virtual, VFSName.MACHINE, size, timer)
}
