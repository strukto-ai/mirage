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
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function splitLinesNoEnds(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

function splitRecords(text: string, zeroTerminated: boolean): string[] {
  if (!zeroTerminated) return splitLinesNoEnds(text)
  const stripped = text.replace(/\0$/, '')
  return stripped === '' ? [] : stripped.split('\0')
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', '0': '' }

// GNU paste recognizes exactly \n, \t, \\ and \0, where \0 means the empty
// delimiter (fields are concatenated) rather than a NUL byte. A single
// left-to-right scan keeps \\0 reading as a backslash followed by 0.
function decodeDelimiters(value: string): string[] {
  const chars: string[] = []
  let index = 0
  while (index < value.length) {
    const char = value[index] ?? ''
    const next = value[index + 1]
    if (char === '\\' && next !== undefined && Object.hasOwn(ESCAPES, next)) {
      chars.push(ESCAPES[next] ?? '')
      index += 2
      continue
    }
    chars.push(char)
    index += 1
  }
  return chars.length > 0 ? chars : ['']
}

function joinFields(fields: readonly string[], delimiters: readonly string[]): string {
  if (fields.length === 0) return ''
  let output = fields[0] ?? ''
  for (let index = 1; index < fields.length; index += 1) {
    output += (delimiters[(index - 1) % delimiters.length] ?? '') + (fields[index] ?? '')
  }
  return output
}

export async function pasteGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const delimiterValue = opts.flags.d ?? opts.flags.delimiters
  const delimiters = decodeDelimiters(typeof delimiterValue === 'string' ? delimiterValue : '\t')
  const serial = opts.flags.s === true || opts.flags.serial === true
  const zeroTerminated = opts.flags.z === true || opts.flags.zero_terminated === true
  const fileLines: string[][] = []
  let stdinConsumed = false
  for (const p of paths) {
    if (p.virtual === '-') {
      const raw = stdinConsumed ? null : await readStdinAsync(opts.stdin)
      stdinConsumed = true
      fileLines.push(splitRecords(raw !== null ? DEC.decode(raw) : '', zeroTerminated))
    } else {
      const data = await materialize(stream(p))
      fileLines.push(splitRecords(DEC.decode(data), zeroTerminated))
    }
  }
  if (fileLines.length === 0 && !stdinConsumed) {
    const raw = await readStdinAsync(opts.stdin)
    fileLines.push(splitRecords(raw !== null ? DEC.decode(raw) : '', zeroTerminated))
  }
  let outLines: string[]
  if (serial) {
    outLines = fileLines
      .filter((lines) => lines.length > 0)
      .map((lines) => joinFields(lines, delimiters))
  } else {
    const maxLen = Math.max(...fileLines.map((l) => l.length))
    outLines = []
    for (let i = 0; i < maxLen; i++) {
      outLines.push(
        joinFields(
          fileLines.map((lines) => lines[i] ?? ''),
          delimiters,
        ),
      )
    }
  }
  const out: ByteSource =
    outLines.length === 0
      ? new Uint8Array(0)
      : ENC.encode(outLines.join(zeroTerminated ? '\0' : '\n') + (zeroTerminated ? '\0' : '\n'))
  return [out, new IOResult()]
}
