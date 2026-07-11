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

import { CommandSpec, Operand, OperandKind, Option } from './types.ts'

// GNU echo is not getopt, so its option surface is a word shape, not a
// CommandSpec: options are LEADING words matching this pattern only.
export const ECHO_OPTION = /^-[neE]+$/

export const SHELL_SPECS = Object.freeze({
  xargs: new CommandSpec({
    description: 'Build and run command lines from standard input.',
    options: [
      new Option({
        short: '-n',
        long: '--max-args',
        valueKind: OperandKind.TEXT,
        description: 'Use at most N arguments per command line.',
      }),
      new Option({
        short: '-d',
        long: '--delimiter',
        valueKind: OperandKind.TEXT,
        description: 'Input items are separated by this character.',
      }),
      new Option({
        short: '-0',
        long: '--null',
        description: 'Input items are terminated by NUL.',
      }),
      new Option({
        short: '-r',
        long: '--no-run-if-empty',
        description: 'Do not run the command on empty input.',
      }),
      new Option({
        short: '-I',
        valueKind: OperandKind.TEXT,
        description: 'Replace occurrences of the token (not supported).',
      }),
      new Option({
        short: '-P',
        long: '--max-procs',
        valueKind: OperandKind.TEXT,
        description: 'Run up to N processes (not supported).',
      }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  timeout: new CommandSpec({
    description: 'Run a command with a time limit.',
    options: [
      new Option({
        short: '-s',
        long: '--signal',
        valueKind: OperandKind.TEXT,
        description: 'Signal to send on timeout (not supported).',
      }),
      new Option({
        short: '-k',
        long: '--kill-after',
        valueKind: OperandKind.TEXT,
        description: 'Also send KILL after this long (not supported).',
      }),
      new Option({
        long: '--preserve-status',
        description: "Exit with the command's status on timeout (not supported).",
      }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  read: new CommandSpec({
    description: 'Read a line from standard input into variables.',
    options: [
      new Option({ short: '-r', description: 'Raw mode: backslash is not an escape character.' }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
})

/**
 * Result of a strict leading-option scan for a shell builtin.
 *
 * Wrapper builtins (xargs, timeout) stop option parsing at the first
 * operand, since everything after it belongs to the wrapped command;
 * the mount-command parser scans the whole line and warns-ignores
 * unknown flags, which is wrong on both counts here. The builtin owns
 * the error message and exit code (GNU shapes differ per tool), so
 * the parse only reports what went wrong.
 */
export interface ShellParse {
  flags: Record<string, string | boolean>
  operands: string[]
  invalid: string | null
  needsValue: string | null
}

/** Scan leading options the way getopt does for a shell builtin. */
export function parseShellOptions(spec: CommandSpec, argv: readonly string[]): ShellParse {
  const shortBool = new Set<string>()
  const shortValue = new Set<string>()
  const longBool = new Set<string>()
  const longValue = new Set<string>()
  const alias = new Map<string, string>()
  for (const opt of spec.options) {
    const short = opt.short === null ? null : opt.short.replace(/^-+/, '')
    const long = opt.long === null ? null : opt.long.replace(/^-+/, '')
    const name = short ?? long ?? ''
    if (short !== null) {
      ;(opt.valueKind === OperandKind.NONE ? shortBool : shortValue).add(short)
      alias.set(short, name)
    }
    if (long !== null) {
      ;(opt.valueKind === OperandKind.NONE ? longBool : longValue).add(long)
      alias.set(long, name)
    }
  }
  const flags: Record<string, string | boolean> = {}
  let i = 0
  while (i < argv.length) {
    const tok = argv[i]
    if (tok === undefined) break
    if (tok === '--') {
      i += 1
      break
    }
    if (tok.startsWith('--') && tok.length > 2) {
      const eq = tok.indexOf('=')
      const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2)
      if (longBool.has(name)) {
        flags[alias.get(name) ?? name] = true
      } else if (longValue.has(name)) {
        if (eq >= 0) {
          flags[alias.get(name) ?? name] = tok.slice(eq + 1)
        } else {
          const value = argv[i + 1]
          if (value === undefined) {
            return { flags, operands: argv.slice(i + 1), invalid: null, needsValue: name }
          }
          i += 1
          flags[alias.get(name) ?? name] = value
        }
      } else {
        return { flags, operands: argv.slice(i + 1), invalid: tok, needsValue: null }
      }
      i += 1
      continue
    }
    if (tok.startsWith('-') && tok.length > 1) {
      const chars = tok.slice(1)
      let j = 0
      while (j < chars.length) {
        const ch = chars[j]
        if (ch === undefined) break
        if (shortBool.has(ch)) {
          flags[alias.get(ch) ?? ch] = true
          j += 1
          continue
        }
        if (shortValue.has(ch)) {
          const rest = chars.slice(j + 1)
          if (rest !== '') {
            flags[alias.get(ch) ?? ch] = rest
          } else {
            const value = argv[i + 1]
            if (value === undefined) {
              return { flags, operands: argv.slice(i + 1), invalid: null, needsValue: ch }
            }
            i += 1
            flags[alias.get(ch) ?? ch] = value
          }
          break
        }
        return { flags, operands: argv.slice(i + 1), invalid: ch, needsValue: null }
      }
      i += 1
      continue
    }
    break
  }
  return { flags, operands: argv.slice(i), invalid: null, needsValue: null }
}
