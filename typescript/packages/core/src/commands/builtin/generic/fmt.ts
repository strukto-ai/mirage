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

function wrapText(text: string, width: number): string {
  const words = text.split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return ''
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    if (current === '') {
      current = w
    } else if (current.length + 1 + w.length <= width) {
      current = current + ' ' + w
    } else {
      lines.push(current)
      current = w
    }
  }
  if (current !== '') lines.push(current)
  return lines.join('\n')
}

function fmtText(text: string, width: number): string {
  const paragraphs = text.split('\n\n')
  const formatted: string[] = []
  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (trimmed !== '') formatted.push(wrapText(trimmed, width))
    else formatted.push('')
  }
  return formatted.join('\n\n') + '\n'
}

export async function fmtGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const width = typeof opts.flags.w === 'string' ? Number.parseInt(opts.flags.w, 10) : 75
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the remaining operands
    // still format (GNU fmt).
    const [ok, err] = await readOperands(paths, stream, 'fmt')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    const parts: string[] = []
    for (const o of ok) {
      parts.push(DEC.decode(o.data))
    }
    const result: ByteSource = ENC.encode(fmtText(parts.join(''), width))
    return [result, io]
  }
  const stdinData = await readStdinAsync(opts.stdin)
  if (stdinData === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('fmt: missing operand\n') })]
  }
  const text = DEC.decode(stdinData)
  const result: ByteSource = ENC.encode(fmtText(text, width))
  return [result, new IOResult()]
}
