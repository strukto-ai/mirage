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

function flagDisplay(opt: Option): string {
  const parts: string[] = []
  if (opt.short !== null) parts.push(opt.short)
  if (opt.long !== null) parts.push(opt.long)
  return parts.join(', ') + VALUE_LABEL[opt.valueKind]
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
    const rows = spec.options.map((o) => [flagDisplay(o), o.description ?? ''])
    const width = Math.max(...rows.map((r) => (r[0] ?? '').length))
    for (const [flag, desc] of rows) {
      const flagStr = flag ?? ''
      const descStr = desc ?? ''
      const padded = flagStr.padEnd(width, ' ')
      lines.push(descStr === '' ? `  ${flagStr}` : `  ${padded}  ${descStr}`)
    }
  }

  if (spec.epilog !== null && spec.epilog !== '') {
    lines.push('')
    lines.push(spec.epilog.replace(/\n+$/, ''))
  }

  return lines.join('\n') + '\n'
}
