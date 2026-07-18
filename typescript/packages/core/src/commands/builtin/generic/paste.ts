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

export async function pasteGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const delimiter = typeof opts.flags.d === 'string' ? opts.flags.d : '\t'
  const serial = opts.flags.s === true
  const fileLines: string[][] = []
  let stdinConsumed = false
  for (const p of paths) {
    if (p.virtual === '-') {
      const raw = stdinConsumed ? null : await readStdinAsync(opts.stdin)
      stdinConsumed = true
      fileLines.push(splitLinesNoEnds(raw !== null ? DEC.decode(raw) : ''))
    } else {
      const data = await materialize(stream(p))
      fileLines.push(splitLinesNoEnds(DEC.decode(data)))
    }
  }
  if (fileLines.length === 0 && !stdinConsumed) {
    const raw = await readStdinAsync(opts.stdin)
    fileLines.push(splitLinesNoEnds(raw !== null ? DEC.decode(raw) : ''))
  }
  let outLines: string[]
  if (serial) {
    outLines = fileLines.filter((lines) => lines.length > 0).map((lines) => lines.join(delimiter))
  } else {
    const maxLen = Math.max(...fileLines.map((l) => l.length))
    outLines = []
    for (let i = 0; i < maxLen; i++) {
      outLines.push(fileLines.map((lines) => lines[i] ?? '').join(delimiter))
    }
  }
  const out: ByteSource =
    outLines.length === 0 ? new Uint8Array(0) : ENC.encode(outLines.join('\n') + '\n')
  return [out, new IOResult()]
}
