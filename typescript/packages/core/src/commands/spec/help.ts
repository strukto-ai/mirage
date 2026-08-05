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

import { type CommandSpec, type Option } from './types.ts'

function valueLabel(opt: Option): string {
  if (opt.type === 'bool') return ''
  // A pair option takes two tokens, and the first one names the value.
  const value = opt.type === 'path' ? '<path>' : '<text>'
  return opt.pair ? ` <name> ${value}` : ` ${value}`
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
  return parts.join(', ') + valueLabel(opt)
}

/** Display rows [flag spelling, description] for a spec's options. */
function flagRows(spec: CommandSpec): [string, string][] {
  return spec.options.map((o) => [flagDisplay(o), o.description ?? ''])
}

/**
 * Render one command's help; a CLI group is the same shape plus a Commands
 * section. `subcommands` carries (name, one-line help) rows for a CLI
 * group node; when given, the usage line reads `<command> [<args>]`
 * instead of the operand slots.
 */
export function renderHelp(
  name: string,
  spec: CommandSpec,
  subcommands: readonly [string, string][] = [],
): string {
  const lines: string[] = []
  if (spec.description !== null && spec.description !== '') {
    lines.push(`${name}: ${spec.description}`)
  } else {
    lines.push(name)
  }
  lines.push('')

  const usageBits = [name]
  if (spec.options.length > 0) usageBits.push('[flags]')
  if (subcommands.length > 0) usageBits.push('<command> [<args>]')
  for (const op of spec.positional) {
    usageBits.push(op.type === 'path' ? '<path>' : '<text>')
  }
  if (spec.rest !== null) {
    usageBits.push(spec.rest.type === 'path' ? '[<path>...]' : '[<text>...]')
  }
  lines.push(`Usage: ${usageBits.join(' ')}`)

  if (subcommands.length > 0) {
    lines.push('')
    lines.push('Commands:')
    const width = Math.max(...subcommands.map(([sub]) => sub.length))
    const sorted = [...subcommands].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    for (const [sub, desc] of sorted) {
      const first = desc.split('\n')[0] ?? ''
      lines.push(first === '' ? `  ${sub}` : `  ${sub.padEnd(width, ' ')}  ${first}`)
    }
  }

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
