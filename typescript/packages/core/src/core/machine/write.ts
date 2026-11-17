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
import { parent } from '../../utils/path.ts'
import { singleQuote } from '../../utils/quote.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { refusal } from '../posix/errors.ts'
import { checked, remote } from './utils.ts'

/**
 * A fresh name beside `target` to stage its bytes under, as short whatever
 * the target's own name, so a name near the length limit still stages.
 *
 * @param target the file's path on the machine.
 */
export function stageName(target: string): string {
  return `${rstripSlash(parent(target))}/.mirage-${crypto.randomUUID().replaceAll('-', '')}`
}

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
  const staged = singleQuote(stageName(target))
  return `cat > ${staged} && mv -f -- ${staged} ${q} || { rm -f -- ${staged}; exit 1; }`
}

/**
 * Write bytes through the machine's file API, for a machine whose exec takes
 * no input (Daytona): straight onto the file, or, with `apply`, onto a
 * sibling name one line on the machine then applies to the file and removes,
 * so an append or an offset write never rewrites the file whole and leaves
 * what a program wrote meanwhile. Mirrors Python's `staged`.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the file.
 * @param data the bytes.
 * @param apply the line that applies the staged file to the file, from both
 *   quoted paths; null writes the file itself.
 */
export async function staged(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  data: Uint8Array,
  apply: ((stage: string, target: string) => string) | null = null,
): Promise<void> {
  const target = remote(accessor, path)
  const handle = accessor.handle(machine)
  if (apply === null) {
    const done = await handle.putFile(target, data)
    if (done.exitCode !== 0) throw refusal(path, done.stderr.length > 0 ? done.stderr : done.stdout)
    return
  }
  const stage = stageName(target)
  const done = await handle.putFile(stage, data)
  if (done.exitCode !== 0) throw refusal(path, done.stderr.length > 0 ? done.stderr : done.stdout)
  const q = singleQuote(stage)
  const line = apply(q, singleQuote(target))
  await checked(accessor, machine, `${line}; s=$?; rm -f -- ${q}; exit $s`, path)
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
      await staged(accessor, machine, path, body, append ? (st, t) => `cat -- ${st} >> ${t}` : null)
    }
  } finally {
    await closeQuietly(data)
  }
  record(append ? 'append' : 'write', path.virtual, VFSName.MACHINE, size, timer)
}
