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
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

export async function lookGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  if (paths.length > 1) throw extraOperandError(CommandName.LOOK, paths[1]?.rawPath ?? '')
  if (texts.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('look: missing prefix\n') })]
  }
  const prefix = texts[0] ?? ''
  const caseInsensitive = opts.flags.f === true
  let raw: Uint8Array
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    raw = await materialize(stream(first))
  } else {
    const stdinData = await readStdinAsync(opts.stdin)
    raw = stdinData ?? new Uint8Array(0)
  }
  const lines = splitLinesNoTrailing(DEC.decode(raw))
  const cmpPrefix = caseInsensitive ? prefix.toLowerCase() : prefix
  const matched: string[] = []
  for (const line of lines) {
    const cmpLine = caseInsensitive ? line.toLowerCase() : line
    if (cmpLine.startsWith(cmpPrefix)) matched.push(line)
  }
  if (matched.length === 0) return [null, new IOResult({ exitCode: 1 })]
  const result: ByteSource = ENC.encode(matched.join('\n') + '\n')
  return [result, new IOResult()]
}
