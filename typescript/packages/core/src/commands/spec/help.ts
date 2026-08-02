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

import { type CommandSpec, OperandKind, type Option } from './types.ts'

const VALUE_LABEL: Record<OperandKind, string> = {
  [OperandKind.NONE]: '',
  [OperandKind.PATH]: ' <path>',
  [OperandKind.TEXT]: ' <text>',
}

// Python's rstrip('\n'). A `/\n+$/` regex is a polynomial ReDoS on a long
// run of trailing newlines, so the trim walks backwards instead.
function trimTrailingNewlines(text: string): string {
  let end = text.length
  while (end > 0 && text[end - 1] === '\n') end -= 1
  return text.slice(0, end)
}

function flagDisplay(opt: Option): string {
  const parts: string[] = []
  if (opt.short !== null) parts.push(opt.short)
  if (opt.long !== null) parts.push(opt.long)
  return parts.join(', ') + VALUE_LABEL[opt.valueKind]
}

/** Display rows [flag spelling, description] for a spec's options. */
export function flagRows(spec: CommandSpec): [string, string][] {
  return spec.options.map((o) => [flagDisplay(o), o.description ?? ''])
}

export function renderHelp(name: string, spec: CommandSpec): string {
  const lines: string[] = []
  if (spec.description !== null && spec.description !== '') {
    lines.push(`${name}: ${spec.description}`)
  } else {
    lines.push(name)
  }
  lines.push('')

  const usageBits = [name]
  if (spec.options.length > 0) usageBits.push('[flags]')
  for (const op of spec.positional) {
    usageBits.push(op.kind === OperandKind.PATH ? '<path>' : '<text>')
  }
  if (spec.rest !== null) {
    usageBits.push(spec.rest.kind === OperandKind.PATH ? '[<path>...]' : '[<text>...]')
  }
  lines.push(`Usage: ${usageBits.join(' ')}`)

  if (spec.options.length > 0) {
    lines.push('')
    lines.push('Flags:')
    const rows = flagRows(spec)
    const width = Math.max(...rows.map(([flag]) => flag.length))
    for (const [flag, desc] of rows) {
      lines.push(desc === '' ? `  ${flag}` : `  ${flag.padEnd(width, ' ')}  ${desc}`)
    }
  }

  if (spec.epilog !== null && spec.epilog !== '') {
    lines.push('')
    lines.push(trimTrailingNewlines(spec.epilog))
  }

  return lines.join('\n') + '\n'
}
