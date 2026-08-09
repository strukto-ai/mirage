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

import { ARG_PLACEHOLDER } from './constants.ts'
import { type CommandSpec, type Operand, type Option, UsageStyle } from './types.ts'

/**
 * The bare name of an option's value, declared or derived.
 *
 * clap derives one from the long spelling when the author declares no
 * `value_name`: dashes to underscores, uppercased. Deriving it the same way
 * means only the options that actually override it have to say so.
 */
export function optionMetavar(opt: Option): string {
  if (opt.metavar !== null) return opt.metavar
  const spelling = opt.long ?? opt.short ?? ''
  return spelling.replace(/^-+/, '').replaceAll('-', '_').toUpperCase()
}

/**
 * One operand's slot in a clap usage line. Required slots take angle brackets
 * and optional ones square, which is the only thing clap's usage line says
 * about arity besides the trailing ellipsis on a variadic.
 */
export function operandSlot(operand: Operand, ellipsis = false): string {
  const name = operand.name === '' ? ARG_PLACEHOLDER : operand.name
  const slot = operand.required ? `<${name}>` : `[${name}]`
  return ellipsis ? `${slot}...` : slot
}

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
function usageLine(
  name: string,
  spec: CommandSpec,
  subcommands: readonly [string, string][],
  style: UsageStyle,
): string {
  const clap = style === UsageStyle.CLAP
  const bits = [name]
  if (spec.options.length > 0) bits.push(clap ? '[OPTIONS]' : '[flags]')
  if (subcommands.length > 0) bits.push(clap ? '<COMMAND>' : '<command> [<args>]')
  for (const op of spec.positional) {
    bits.push(clap ? operandSlot(op) : op.type === 'path' ? '<path>' : '<text>')
  }
  if (spec.rest !== null) {
    if (clap) bits.push(operandSlot(spec.rest, !spec.rest.required))
    else bits.push(spec.rest.type === 'path' ? '[<path>...]' : '[<text>...]')
  }
  return `Usage: ${bits.join(' ')}`
}

export function renderHelp(
  name: string,
  spec: CommandSpec,
  subcommands: readonly [string, string][] = [],
  style: UsageStyle = UsageStyle.ARGPARSE,
): string {
  const clap = style === UsageStyle.CLAP
  const lines: string[] = []
  if (spec.description === null || spec.description === '') {
    lines.push(name)
  } else if (clap) {
    lines.push(spec.description)
  } else {
    lines.push(`${name}: ${spec.description}`)
  }
  lines.push('')

  lines.push(usageLine(name, spec, subcommands, style))

  if (subcommands.length > 0) {
    lines.push('')
    lines.push('Commands:')
    const width = Math.max(...subcommands.map(([sub]) => sub.length))
    // clap prints subcommands in the order the program declares them, which is
    // a deliberate ordering by an author rather than an alphabet, so re-sorting
    // would lose information.
    const subRows = clap ? subcommands : [...subcommands].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    for (const [sub, desc] of subRows) {
      const first = desc.split('\n')[0] ?? ''
      lines.push(first === '' ? `  ${sub}` : `  ${sub.padEnd(width, ' ')}  ${first}`)
    }
  }

  if (spec.options.length > 0) {
    lines.push('')
    lines.push(clap ? 'Options:' : 'Flags:')
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
