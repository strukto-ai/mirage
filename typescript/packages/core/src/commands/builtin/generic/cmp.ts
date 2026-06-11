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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { formatRecords } from '../utils/output.ts'

const ENC = new TextEncoder()

function octal(n: number): string {
  return n.toString(8)
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

export async function cmpGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  if (paths.length < 2) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('cmp: requires two paths\n') })]
  }
  const p0 = paths[0]
  const p1 = paths[1]
  if (p0 === undefined || p1 === undefined) return [null, new IOResult()]
  let data1 = await materialize(stream(p0))
  let data2 = await materialize(stream(p1))
  if (typeof opts.flags.i === 'string') {
    const skip = Number.parseInt(opts.flags.i, 10)
    data1 = data1.slice(skip)
    data2 = data2.slice(skip)
  }
  if (typeof opts.flags.n === 'string') {
    const limit = Number.parseInt(opts.flags.n, 10)
    data1 = data1.slice(0, limit)
    data2 = data2.slice(0, limit)
  }
  if (arraysEqual(data1, data2)) return [null, new IOResult()]
  if (opts.flags.s === true) return [null, new IOResult({ exitCode: 1 })]
  if (opts.flags.args_l === true) {
    const outLines: string[] = []
    const limit = Math.min(data1.byteLength, data2.byteLength)
    for (let idx = 0; idx < limit; idx++) {
      if (data1[idx] !== data2[idx]) {
        outLines.push(`${String(idx + 1)} ${octal(data1[idx] ?? 0)} ${octal(data2[idx] ?? 0)}`)
      }
    }
    const out: ByteSource = formatRecords(outLines)
    return [out, new IOResult({ exitCode: 1 })]
  }
  const limit = Math.min(data1.byteLength, data2.byteLength)
  for (let idx = 0; idx < limit; idx++) {
    if (data1[idx] !== data2[idx]) {
      let line = 1
      for (let k = 0; k < idx; k++) if (data1[k] === 0x0a) line += 1
      let msg = `${p0.original} ${p1.original} differ: char ${String(idx + 1)}, line ${String(line)}`
      if (opts.flags.b === true) {
        msg += ` is ${octal(data1[idx] ?? 0)} ${String.fromCharCode(data1[idx] ?? 0)} ${octal(data2[idx] ?? 0)} ${String.fromCharCode(data2[idx] ?? 0)}`
      }
      return [formatRecords([msg]), new IOResult({ exitCode: 1 })]
    }
  }
  const shorter = data1.byteLength < data2.byteLength ? p0 : p1
  return [formatRecords([`cmp: EOF on ${shorter.original}`]), new IOResult({ exitCode: 1 })]
}
