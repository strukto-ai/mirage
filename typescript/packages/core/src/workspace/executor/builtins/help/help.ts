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

import { atoi } from '../../../../commands/builtin/utils/strtol.ts'
import { compileSpec } from '../../../../commands/spec/compile.ts'
import { SHELL_SPECS } from '../../../../commands/spec/shell.ts'
import { versionLine } from '../../../../commands/spec/standard.ts'
import { SHELL_SYNOPSES } from '../../../../commands/spec/synopsis.ts'
import type { CommandSpec } from '../../../../commands/spec/types.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { runs } from '../../../../policy/match/allow.ts'
import { decodeText, encodeText } from '../../../../shell/bytes.ts'
import { fnmatch } from '../../../../utils/fnmatch.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { BASH_BUILTINS } from '../../../lookup/constants.ts'
import type { SessionState } from '../../../session/session.ts'
import { visibleEnv } from '../../../session/state.ts'
import { scanOptions } from '../getopt.ts'
import { builtinError, builtinUsage, result } from '../shared.ts'
import type { BuiltinCall } from '../types.ts'
import {
  DEFAULT_COLUMNS,
  DESCRIPTION,
  GUIDE,
  MAX_CELL,
  MIN_COLUMNS,
  OPERAND_HELP,
  TEXT_WIDTH,
} from './constants.ts'

const INDENT = '    '

// Every topic, in the order the listing and a pattern's matches show.
export const TOPICS: readonly string[] = Object.keys(SHELL_SYNOPSES).sort(compareCodePoints)

function specOf(name: string): CommandSpec {
  const spec = SHELL_SPECS[name]
  if (spec === undefined) throw new Error(`no shell spec: ${name}`)
  return spec
}

/** A spec's free text as paragraphs, split at its blank lines. */
export function paragraphs(text: string | null): string[] {
  if (text === null || text === '') return []
  return text
    .split('\n\n')
    .filter((part) => part.trim() !== '')
    .map((part) => part.trim().split(/\s+/).join(' '))
}

/** The one line a spec's description opens with. */
export function summary(spec: CommandSpec): string {
  return paragraphs(spec.description)[0] ?? ''
}

/**
 * Each option of a builtin, as its help lists it: the letter and the name of
 * its value, and what it does.
 */
export function optionRows(spec: CommandSpec): [string, string][] {
  return compileSpec(spec).options.map((opt) => {
    let label = opt.names[0] ?? ''
    if (opt.action !== 'store_true' && opt.action !== 'count' && opt.metavar) {
      label += ` ${opt.metavar}`
    }
    return [label, opt.help ?? '']
  })
}

/**
 * Where a word may break across lines: after a hyphen that follows a letter
 * or digit, so `read-only` breaks and `--all` does not.
 */
function breakPoints(word: string): number[] {
  const points: number[] = []
  for (let i = 1; i < word.length - 1; i += 1) {
    if (word[i] === '-' && /^[\p{L}\p{N}]$/u.test(word[i - 1] ?? '')) points.push(i + 1)
  }
  return points
}

/**
 * Lay text out in lines of at most `width` characters. Words go on a line
 * while they fit; a word that does not fit breaks after its last hyphen that
 * still does, and a word longer than a line with nowhere to break runs past
 * it. This is how a manual page fills text with justification and
 * hyphenation off.
 */
export function fill(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const whole of text.split(/\s+/).filter((w) => w !== '')) {
    let word = whole
    while (word !== '') {
      const room = width - line.length - (line !== '' ? 1 : 0)
      if (word.length <= room) {
        line = line !== '' ? `${line} ${word}` : word
        break
      }
      const cut = Math.max(0, ...breakPoints(word).filter((p) => p <= room))
      if (cut > 0) {
        lines.push(line !== '' ? `${line} ${word.slice(0, cut)}` : word.slice(0, cut))
        line = ''
        word = word.slice(cut)
      } else if (line !== '') {
        lines.push(line)
        line = ''
      } else {
        line = word
        word = ''
      }
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

/** A paragraph of a topic's help, filled and indented. */
function indented(text: string): string[] {
  return fill(text, TEXT_WIDTH - INDENT.length).map((line) => INDENT + line)
}

/**
 * A topic's help below its synopsis line: the summary, then the description,
 * the options and the exit status, each set off by an indented blank line.
 */
function topicBody(spec: CommandSpec): string[] {
  const [lead = '', ...text] = paragraphs(spec.description)
  const lines = [INDENT + lead]
  for (const paragraph of text) lines.push(INDENT, ...indented(paragraph))
  const rows = optionRows(spec)
  if (rows.length > 0) {
    lines.push(INDENT, `${INDENT}Options:`)
    lines.push(...rows.map(([flag, does]) => `      ${flag}\t${does}`))
  }
  if (spec.epilog !== null && spec.epilog !== '') {
    lines.push(INDENT, `${INDENT}Exit Status:`, ...indented(spec.epilog))
  }
  return lines
}

/** What `help NAME` and `NAME --help` print. */
export function topicHelp(name: string): string {
  return `${[`${name}: ${SHELL_SYNOPSES[name] ?? ''}`, ...topicBody(specOf(name))].join('\n')}\n`
}

/** What `help -m NAME` prints: the help laid out in a manual page's sections. */
function manual(name: string): string {
  const spec = specOf(name)
  const lines = [
    'NAME',
    `${INDENT}${name} - ${summary(spec)}`,
    '',
    'SYNOPSIS',
    INDENT + (SHELL_SYNOPSES[name] ?? ''),
    '',
    'DESCRIPTION',
    ...topicBody(spec),
    '',
    'SEE ALSO',
    `${INDENT}bash(1)`,
    '',
    'IMPLEMENTATION',
    INDENT + versionLine('bash').replace(/\n$/, ''),
    '',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * The width the first of `names` sets, read as C's `atoi` reads it, passing
 * over one under `least`; `fallback` when none sets one.
 */
export function envWidth(
  session: SessionState,
  names: readonly string[],
  least: number,
  fallback: number,
): number {
  const env = visibleEnv(session)
  for (const name of names) {
    const width = atoi(env[name] ?? '')
    if (width >= least) return width
  }
  return fallback
}

/** Whether the session may not run a builtin at all, which the listing marks with a star. */
export function disabled(name: string, session: SessionState): boolean {
  return BASH_BUILTINS.has(name) && !runs(name, session.commands ?? null)
}

/** One entry of the listing: its mark and synopsis, cut with `>` once the synopsis reaches `room` characters. */
function cell(name: string, session: SessionState, room: number): string {
  const mark = disabled(name, session) ? '*' : ' '
  let text = SHELL_SYNOPSES[name] ?? ''
  if (text.length >= room) text = `${text.slice(0, Math.max(room, 0))}>`
  return mark + text
}

/** Every topic's synopsis in two columns, under the shell's name and a guide to the listing. */
function listing(session: SessionState): string {
  const columns = envWidth(session, ['COLUMNS'], MIN_COLUMNS, DEFAULT_COLUMNS)
  const width = Math.min(Math.floor(columns / 2), MAX_CELL)
  const rows = Math.floor((TOPICS.length + 1) / 2)
  const lines = [versionLine('bash').replace(/\n$/, ''), DESCRIPTION, ...GUIDE, '']
  for (let i = 0; i < rows; i += 1) {
    const left = cell(TOPICS[i] ?? '', session, width - 3)
    const right = TOPICS[i + rows]
    lines.push(right !== undefined ? left.padEnd(width) + cell(right, session, width - 4) : left)
  }
  return `${lines.join('\n')}\n`
}

/** Whether a pattern is a glob, which titles the output with the patterns asked for. */
function globbed(pattern: string): boolean {
  if (pattern.includes('*') || pattern.includes('?')) return true
  const start = pattern.indexOf('[')
  return start >= 0 && pattern.slice(start + 1).includes(']')
}

/** The topics a pattern names: the one it spells exactly, else every one it begins or matches as a glob. */
export function matching(pattern: string): string[] {
  if (SHELL_SYNOPSES[pattern] !== undefined) return [pattern]
  return TOPICS.filter((name) => name.startsWith(pattern) || fnmatch(name, pattern))
}

/**
 * A builtin's answer to `--help` as its first word: its help, and status 2.
 * Null for a word that reads `--help` as an operand, and for any word that is
 * no builtin.
 */
export function flagHelp(name: string): RedirectResult | null {
  if (SHELL_SYNOPSES[name] === undefined || !BASH_BUILTINS.has(name) || OPERAND_HELP.has(name)) {
    return null
  }
  return result(name, { out: encodeText(topicHelp(name)), exitCode: 2 })
}

/**
 * The `help` arm: the listing, or what each pattern names. `-d` wins over
 * `-m` and `-m` over `-s`. A pattern that matches nothing is passed over;
 * only when none matches is there an error, and it names the last.
 */
export function helpBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  const session = call.context.session
  const scan = scanOptions([...call.argv.args], 'dms')
  if (scan.bad !== null) {
    const message = decodeText(builtinError('help', `${scan.bad}: invalid option`))
    return Promise.resolve(result('help', { exitCode: 2, stderr: message + builtinUsage('help') }))
  }
  if (scan.operands.length === 0) {
    return Promise.resolve(result('help', { out: encodeText(listing(session)) }))
  }
  const mode = ['d', 'm', 's'].find((m) => scan.letters.includes(m)) ?? null
  const out: string[] = []
  const first = scan.operands[0] ?? ''
  if (globbed(first)) {
    const plural = scan.operands.length > 1 ? 's' : ''
    out.push(`Shell commands matching keyword${plural} \`${scan.operands.join(', ')}'\n\n`)
  }
  let found = false
  for (const pattern of scan.operands) {
    for (const name of matching(pattern)) {
      found = true
      if (mode === 'd') out.push(`${name} - ${summary(specOf(name))}\n`)
      else if (mode === 'm') out.push(manual(name))
      else if (mode === 's') out.push(`${name}: ${SHELL_SYNOPSES[name] ?? ''}\n`)
      else out.push(topicHelp(name))
    }
  }
  if (found) return Promise.resolve(result('help', { out: encodeText(out.join('')) }))
  const last = scan.operands[scan.operands.length - 1] ?? ''
  const message = decodeText(
    builtinError(
      'help',
      `no help topics match \`${last}'.  Try \`help help' or \`man -k ${last}' or \`info ${last}'.`,
    ),
  )
  return Promise.resolve(
    result('help', {
      out: out.length > 0 ? encodeText(out.join('')) : null,
      exitCode: 1,
      stderr: message,
    }),
  )
}
