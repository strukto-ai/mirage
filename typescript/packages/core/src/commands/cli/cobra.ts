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

// Follows gh 2.85.0's root usage function and error printing (MIT; see
// licenses/third_party/gh.txt), Cobra 1.10.2's unknown-command suggestions
// (Apache-2.0; licenses/third_party/cobra.txt) and pflag 1.0.10's option table
// and refusals (BSD-3-Clause; licenses/third_party/pflag.txt).

import type { ParsedArgs } from '../spec/parser.ts'
import type { Argument, CommandSpec } from '../spec/types.ts'
import type { ParsedCommand } from '../../workspace/executor/command/types.ts'
import { compareCodePoints } from '../../utils/sort.ts'

export const COBRA_EXIT = 1
const SUGGESTION_DISTANCE = 2
const UNKNOWN_OPTION = 'unknown option: '
const NEEDS_VALUE_HEAD = "error: option '"
const NEEDS_VALUE_TAIL = "' requires a value"
const DEPRECATED = 'Deprecated:'
const GIT_FLAGS_HINT: Readonly<Record<string, string>> = {
  'gist clone': "Separate git clone flags with '--'.",
  'repo clone': "Separate git clone flags with '--'.",
  'repo fork': 'Separate git clone flags with `--`.',
}
const NO_FLAGS_IN_USE = new Set(['gist clone', 'release create', 'release edit', 'repo clone'])

function longName(argument: Argument): string {
  return argument.names.find((name) => name.startsWith('--')) ?? ''
}

function shortName(argument: Argument): string {
  return argument.names.find((name) => name.startsWith('-') && !name.startsWith('--')) ?? ''
}

function isSwitch(argument: Argument): boolean {
  return argument.action === 'store_true' || (argument.nargs === '?' && argument.attachedOnly)
}

// gh adds `-R` to a whole group as a persistent flag, which a command's usage
// leaves out, and Mirage declares it on each leaf. A command that declares
// `-R` itself names its value.
function isInherited(argument: Argument): boolean {
  return (
    argument.names.length === 2 &&
    argument.names[0] === '-R' &&
    argument.names[1] === '--repo' &&
    argument.metavar === null
  )
}

function valueName(argument: Argument): string {
  if (argument.metavar !== null) return argument.metavar
  if (isSwitch(argument)) return ''
  if (argument.type === 'int') return 'int'
  return argument.action === 'append' ? 'strings' : 'string'
}

function flagLabel(argument: Argument): string {
  const short = shortName(argument)
  const long = longName(argument)
  return short !== '' ? `${short}, ${long}` : long
}

function usageText(argument: Argument): string {
  let text = argument.help ?? ''
  if (argument.choices.length > 0 && !isSwitch(argument) && !text.includes('{')) {
    text = `${text}: {${argument.choices.join('|')}}`
  }
  if (argument.default !== null) {
    const shown = argument.type === 'int' ? argument.default : `"${argument.default}"`
    text = `${text} (default ${shown})`
  }
  return text
}

function flagUsages(node: CommandSpec): string {
  const options = node.arguments
    .filter(
      (argument) =>
        longName(argument) !== '' &&
        !isInherited(argument) &&
        !(argument.help ?? '').startsWith(DEPRECATED),
    )
    .sort((left, right) => compareCodePoints(longName(left), longName(right)))
  if (options.length === 0) return ''
  const leads = options.map((argument) => {
    const short = shortName(argument)
    const lead = short !== '' ? `  ${short}, ${longName(argument)}` : `      ${longName(argument)}`
    const value = valueName(argument)
    return value !== '' ? `${lead} ${value}` : lead
  })
  const width = Math.max(...leads.map((lead) => lead.length))
  const lines = options.map((argument, index) => {
    const lead = leads[index] ?? ''
    return `${lead}${' '.repeat(width - lead.length + 3)}${usageText(argument)}`
  })
  const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length))
  return `${lines.map((line) => `  ${line.slice(indent)}\n`).join('')}  `
}

export function cobraUsage(name: string, node: CommandSpec): string {
  if (node.subcommands.length > 0) {
    const slot = name.includes(' ') ? '<command>' : '<command> <subcommand>'
    const children = node.subcommands.map((child) => child.name).sort(compareCodePoints)
    const rows = children.map((child) => `  ${child}\n`).join('')
    return `Usage:  ${name} ${slot} [flags]\n\nAvailable commands:\n${rows}\n`
  }
  const words = node.arguments
    .filter((argument) => !(argument.names[0] ?? '').startsWith('-'))
    .map((argument) => argument.metavar ?? argument.names[0] ?? '')
  let use = [name, ...words].join(' ')
  if (!NO_FLAGS_IN_USE.has(name.slice(name.indexOf(' ') + 1))) use = `${use} [flags]`
  const flags = flagUsages(node)
  return flags !== '' ? `Usage:  ${use}\n\nFlags:\n${flags}\n` : `Usage:  ${use}\n`
}

export function cobraRefusal(message: string, name: string, node: CommandSpec): string {
  const gap = message.endsWith('\n') ? '\n' : '\n\n'
  return `${message}${gap}${cobraUsage(name, node)}`
}

export function setsValueFlag(node: CommandSpec, argv: readonly string[]): boolean {
  const spellings = new Set(
    node.arguments
      .filter((argument) => !isSwitch(argument))
      .flatMap((argument) => argument.names.filter((name) => name.startsWith('-'))),
  )
  for (const word of argv) {
    if (word === '--') return false
    if (
      word.startsWith('-') &&
      (spellings.has(word.split('=', 1)[0] ?? '') || spellings.has(word.slice(0, 2)))
    ) {
      return true
    }
  }
  return false
}

function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function shorthandTail(letter: string, argv: readonly string[]): string {
  for (const word of argv) {
    if (word === '--') break
    if (word.startsWith('-') && !word.startsWith('--')) {
      const where = word.indexOf(letter, 1)
      if (where > 0) return word.slice(where)
    }
  }
  return letter
}

function unknownFlag(token: string, argv: readonly string[]): string {
  if (token.startsWith('--')) return `unknown flag: ${token.split('=', 1)[0] ?? token}`
  const letter = token.replace(/^-+/, '')
  return `unknown shorthand flag: '${letter}' in -${shorthandTail(letter, argv)}`
}

function needsValue(token: string, argv: readonly string[]): string {
  if (token.startsWith('--')) return `flag needs an argument: ${token}`
  const letter = token.replace(/^-+/, '')
  return `flag needs an argument: '${letter}' in -${shorthandTail(letter, argv)}`
}

function argumentNamed(node: CommandSpec, spelling: string): Argument | undefined {
  return node.arguments.find((argument) => argument.names.includes(spelling))
}

function invalidValue(node: CommandSpec, spelling: string, value: string, reason: string): string {
  const argument = argumentNamed(node, spelling)
  const label = argument !== undefined ? flagLabel(argument) : spelling
  return `invalid argument ${quoted(value)} for ${quoted(label)} flag: ${reason}`
}

export function leafMessage(
  parsed: ParsedCommand | ParsedArgs,
  node: CommandSpec,
  argv: readonly string[],
  path: string,
): string | null {
  const message = optionMessage(parsed, node, argv)
  const hint = GIT_FLAGS_HINT[path]
  return message !== null && hint !== undefined ? `${message}\n${hint}` : message
}

function optionMessage(
  parsed: ParsedCommand | ParsedArgs,
  node: CommandSpec,
  argv: readonly string[],
): string | null {
  const kind = parsed.optionErrorKinds[0]
  if (kind === 'invalid') return unknownFlag(parsed.invalidOptions[0] ?? '', argv)
  if (kind === 'needs_value') return needsValue(parsed.needsValueOptions[0] ?? '', argv)
  if (kind === 'int') {
    const [option, value] = parsed.invalidIntOptions[0] ?? ['', '']
    return invalidValue(
      node,
      option,
      value,
      `strconv.ParseInt: parsing ${quoted(value)}: invalid syntax`,
    )
  }
  if (kind === 'value') {
    const [option = '', value = ''] = parsed.invalidValueOptions[0] ?? []
    const argument = argumentNamed(node, option)
    if (argument !== undefined && isSwitch(argument)) {
      return invalidValue(
        node,
        option,
        value,
        `strconv.ParseBool: parsing ${quoted(value)}: invalid syntax`,
      )
    }
    const choices = argument !== undefined ? argument.choices.join('|') : ''
    return invalidValue(node, option, value, `valid values are {${choices}}`)
  }
  return null
}

export function groupMessage(message: string, token: string | undefined): string {
  if (token !== undefined) return unknownFlag(token, [])
  if (message.startsWith(UNKNOWN_OPTION)) {
    return unknownFlag(message.slice(UNKNOWN_OPTION.length), [])
  }
  if (message.startsWith(NEEDS_VALUE_HEAD) && message.endsWith(NEEDS_VALUE_TAIL)) {
    return needsValue(message.slice(NEEDS_VALUE_HEAD.length, -NEEDS_VALUE_TAIL.length), [])
  }
  return message
}

function distance(left: string, right: string): number {
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current.push(
        Math.min(
          (previous[j] ?? 0) + 1,
          (current[j - 1] ?? 0) + 1,
          (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      )
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

export function unknownCommand(word: string, name: string, node: CommandSpec): string {
  const near = node.subcommands
    .map((child) => child.name)
    .filter(
      (child) =>
        distance(word, child) <= SUGGESTION_DISTANCE ||
        child.toLowerCase().startsWith(word.toLowerCase()),
    )
    .sort(compareCodePoints)
  const hint =
    near.length > 0 ? `\n\nDid you mean this?\n${near.map((n) => `\t${n}\n`).join('')}` : ''
  return `unknown command ${quoted(word)} for ${quoted(name)}${hint}`
}
