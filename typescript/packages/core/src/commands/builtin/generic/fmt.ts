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

function leadingSpaces(line: string): string {
  return line.slice(0, line.length - line.trimStart().length)
}

function indentWrapped(
  text: string,
  firstIndent: string,
  bodyIndent: string,
  width: number,
): string {
  const wrapped = wrapText(text, Math.max(1, width - bodyIndent.length)).split('\n')
  if (wrapped.length === 0) return ''
  const lines = [firstIndent + (wrapped[0] ?? '')]
  for (const line of wrapped.slice(1)) lines.push(bodyIndent + line)
  return lines.join('\n')
}

function formatParagraph(
  paragraph: string,
  width: number,
  prefix: string | null,
  splitOnly: boolean,
  tagged: boolean,
  crown: boolean,
): string {
  let lines = paragraph.split('\n')
  if (lines.at(-1) === '') lines = lines.slice(0, -1)
  if (prefix !== null) {
    if (lines.some((line) => !line.startsWith(prefix))) return paragraph
    lines = lines.map((line) => line.slice(prefix.length))
  }
  const firstIndent = leadingSpaces(lines[0] ?? '')
  const bodyIndent =
    (tagged || crown) && lines.length > 1 ? leadingSpaces(lines[1] ?? '') : firstIndent
  let result: string
  if (splitOnly) {
    result = lines
      .map((line) => {
        const indent = leadingSpaces(line)
        return indentWrapped(line.trim(), indent, indent, width)
      })
      .join('\n')
  } else {
    result = indentWrapped(
      lines.map((line) => line.trim()).join(' '),
      firstIndent,
      bodyIndent,
      width,
    )
  }
  if (prefix !== null)
    result = result
      .split('\n')
      .map((line) => prefix + line)
      .join('\n')
  return result
}

function fmtText(
  text: string,
  width: number,
  goal: number | null,
  prefix: string | null,
  splitOnly: boolean,
  tagged: boolean,
  crown: boolean,
): string {
  const targetWidth = goal === null ? width : Math.min(width, goal)
  const paragraphs = text.split('\n\n')
  const formatted: string[] = []
  for (const para of paragraphs) {
    if (para.trim() !== '') {
      formatted.push(formatParagraph(para, targetWidth, prefix, splitOnly, tagged, crown))
    } else formatted.push('')
  }
  return formatted.join('\n\n') + '\n'
}

export async function fmtGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const widthValue = opts.flags.w ?? opts.flags.width
  const goalValue = opts.flags.g ?? opts.flags.goal
  const prefixValue = opts.flags.p ?? opts.flags.prefix
  const width = typeof widthValue === 'string' ? Number.parseInt(widthValue, 10) : 75
  const goal = typeof goalValue === 'string' ? Number.parseInt(goalValue, 10) : null
  const prefix = typeof prefixValue === 'string' ? prefixValue : null
  const splitOnly = opts.flags.s === true || opts.flags.split_only === true
  const tagged = opts.flags.t === true || opts.flags.tagged_paragraph === true
  const crown = opts.flags.c === true || opts.flags.crown_margin === true
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
    const result: ByteSource = ENC.encode(
      fmtText(parts.join(''), width, goal, prefix, splitOnly, tagged, crown),
    )
    return [result, io]
  }
  const stdinData = await readStdinAsync(opts.stdin)
  if (stdinData === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('fmt: missing operand\n') })]
  }
  const text = DEC.decode(stdinData)
  const result: ByteSource = ENC.encode(
    fmtText(text, width, goal, prefix, splitOnly, tagged, crown),
  )
  return [result, new IOResult()]
}
