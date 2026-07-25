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
import { PathSpec } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

function shuffleInPlace(arr: string[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i] ?? ''
    arr[i] = arr[j] ?? ''
    arr[j] = tmp
  }
}

function choicesWithReplacement(items: readonly string[], k: number): string[] {
  if (items.length === 0) return []
  const out: string[] = []
  for (let i = 0; i < k; i++) {
    out.push(items[Math.floor(Math.random() * items.length)] ?? '')
  }
  return out
}

function processItems(items: string[], repeat: boolean, nFlag: number | null): string[] {
  if (repeat) {
    const count = nFlag ?? items.length
    return choicesWithReplacement(items, count)
  }
  shuffleInPlace(items)
  if (nFlag !== null) return items.slice(0, nFlag)
  return items
}

export async function shufGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  const countValue = opts.flags.n ?? opts.flags.head_count
  const rangeValue = opts.flags.i ?? opts.flags.input_range
  const outputValue = opts.flags.o ?? opts.flags.output
  const nFlag = typeof countValue === 'string' ? Number.parseInt(countValue, 10) : null
  const inputRange = typeof rangeValue === 'string' ? rangeValue : null
  const output =
    outputValue instanceof PathSpec
      ? outputValue
      : typeof outputValue === 'string'
        ? new PathSpec({
            virtual: outputValue,
            directory: outputValue,
            resourcePath: mountKey(outputValue, opts.mountPrefix ?? ''),
            resolved: true,
          })
        : null
  const echoMode = opts.flags.e === true || opts.flags.echo === true
  const zeroSep = opts.flags.z === true || opts.flags.zero_terminated === true
  const repeat = opts.flags.r === true || opts.flags.repeat === true
  const sep = zeroSep ? '\x00' : '\n'

  let items: string[]
  if (inputRange !== null) {
    const match = /^(-?\d+)-(-?\d+)$/.exec(inputRange)
    if (match === null) {
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: ENC.encode(`shuf: invalid input range: ${inputRange}\n`),
        }),
      ]
    }
    const low = Number.parseInt(match[1] ?? '0', 10)
    const high = Number.parseInt(match[2] ?? '0', 10)
    items = []
    for (let value = low; value <= high; value++) items.push(String(value))
  } else if (echoMode) {
    const base = paths.length > 0 ? paths.map((p) => p.mountPath) : [...texts]
    items = base
  } else if (paths.length > 0) {
    items = []
    for (const p of paths) {
      const data = DEC.decode(await materialize(stream(p)))
      if (zeroSep) for (const l of data.split('\x00')) items.push(l)
      else for (const l of splitLinesNoTrailing(data)) items.push(l)
    }
  } else {
    const stdinData = await readStdinAsync(opts.stdin)
    if (stdinData === null) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('shuf: missing operand\n') })]
    }
    const text = DEC.decode(stdinData)
    items = zeroSep ? text.split('\x00') : splitLinesNoTrailing(text)
  }
  const out = processItems(items, repeat, nFlag)
  const result: ByteSource = ENC.encode(out.join(sep) + sep)
  if (output !== null) {
    await write(output, result)
    return [null, new IOResult({ writes: { [output.mountPath]: result } })]
  }
  return [result, new IOResult()]
}
