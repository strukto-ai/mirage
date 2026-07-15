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

import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { operandsIo, readOperands } from '../utils/operands.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function expandTabs(text: string, tabsize: number): string {
  const out: string[] = []
  let col = 0
  for (const ch of text) {
    if (ch === '\t') {
      const spaces = tabsize - (col % tabsize)
      out.push(' '.repeat(spaces))
      col += spaces
    } else if (ch === '\n') {
      out.push(ch)
      col = 0
    } else {
      out.push(ch)
      col += 1
    }
  }
  return out.join('')
}

function expandLeadingTabs(text: string, tabsize: number): string {
  const lines = text.split('\n')
  const result: string[] = []
  for (const line of lines) {
    let i = 0
    while (i < line.length && (line[i] === '\t' || line[i] === ' ')) i += 1
    if (i === 0) {
      result.push(line)
    } else {
      const leading = line.slice(0, i)
      const rest = line.slice(i)
      result.push(expandTabs(leading, tabsize) + rest)
    }
  }
  return result.join('\n')
}

function applyExpand(txt: string, leadingOnly: boolean, tabsize: number): string {
  return leadingOnly ? expandLeadingTabs(txt, tabsize) : expandTabs(txt, tabsize)
}

export async function expandGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const tabsize = typeof opts.flags.t === 'string' ? Number.parseInt(opts.flags.t, 10) : 8
  const leadingOnly = opts.flags.i === true
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the remaining operands
    // still expand (GNU expand).
    const [ok, err] = await readOperands(paths, stream, 'expand')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    const parts: string[] = []
    for (const o of ok) {
      parts.push(applyExpand(DEC.decode(o.data), leadingOnly, tabsize))
    }
    const result: ByteSource = ENC.encode(parts.join(''))
    return [result, io]
  }
  const stdinData = await readStdinAsync(opts.stdin)
  if (stdinData === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('expand: missing operand\n') })]
  }
  const text = DEC.decode(stdinData)
  const result: ByteSource = ENC.encode(applyExpand(text, leadingOnly, tabsize))
  return [result, new IOResult()]
}
