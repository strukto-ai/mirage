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
import { compileSpec, expandLong, optionSpellings } from './compile.ts'
import { HELP_OPTION, VERSION_OPTION } from './constants.ts'
import { CommandSpec, Argument } from './types.ts'

export const SHELL_SPECS = Object.freeze({
  xargs: new CommandSpec({
    description: 'Build and run command lines from standard input.',
    arguments: [
      new Argument(['-0', '--null'], {
        action: 'store_true',
        help: 'Input items are terminated by NUL.',
      }),
      new Argument(['-a', '--arg-file'], {
        help: 'Read items from this file, not standard input.',
      }),
      new Argument(['-d', '--delimiter'], { help: 'Input items are separated by this character.' }),
      new Argument('-E', { help: 'Stop reading at this logical end-of-file string.' }),
      new Argument(['-e', '--eof'], {
        nargs: '?',
        attachedOnly: true,
        help: 'Same as -E; no string turns it off.',
      }),
      new Argument('-I', {
        help: 'Replace this string in the initial arguments with each input line.',
      }),
      new Argument(['-i', '--replace'], {
        nargs: '?',
        attachedOnly: true,
        help: 'Same as -I, with {} when no string is attached.',
      }),
      new Argument('-L', { help: 'Use at most N non-blank input lines per command line.' }),
      new Argument(['-l', '--max-lines'], {
        nargs: '?',
        attachedOnly: true,
        help: 'Same as -L, with 1 when no count is attached.',
      }),
      new Argument(['-n', '--max-args'], { help: 'Use at most N arguments per command line.' }),
      new Argument(['-o', '--open-tty'], {
        action: 'store_true',
        help: 'Reopen stdin as the terminal in each command (there is no terminal, so this fails).',
      }),
      new Argument(['-p', '--interactive'], {
        action: 'store_true',
        help: 'Prompt before running each command (there is no terminal, so this fails).',
      }),
      new Argument(['-r', '--no-run-if-empty'], {
        action: 'store_true',
        help: 'Do not run the command on empty input.',
      }),
      new Argument(['-s', '--max-chars'], { help: 'Limit a command line to N bytes.' }),
      new Argument(['-t', '--verbose'], {
        action: 'store_true',
        help: 'Print each command on stderr before running it.',
      }),
      new Argument('--show-limits', {
        action: 'store_true',
        help: 'Show the command-line length limits.',
      }),
      new Argument(['-x', '--exit'], {
        action: 'store_true',
        help: 'Exit if a command line exceeds the size limit.',
      }),
      new Argument(['-P', '--max-procs'], {
        help: 'Run up to N commands at a time; 0 runs them all at once.',
      }),
      new Argument('--process-slot-var', {
        help: "Set this variable to each command's slot number.",
      }),
      VERSION_OPTION,
      HELP_OPTION,
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  timeout: new CommandSpec({
    description: 'Run a command with a time limit.',
    arguments: [
      new Argument(['-f', '--foreground'], {
        action: 'store_true',
        help: 'Signal only the command, not its process group.',
      }),
      new Argument(['-k', '--kill-after'], {
        help: 'Also send KILL this long after the first signal.',
      }),
      new Argument(['-p', '--preserve-status'], {
        action: 'store_true',
        help: "Exit with the command's status even when it times out.",
      }),
      new Argument(['-s', '--signal'], { help: 'Signal to send on timeout (default TERM).' }),
      new Argument(['-v', '--verbose'], {
        action: 'store_true',
        help: 'Report each signal sent on stderr.',
      }),
      HELP_OPTION,
      VERSION_OPTION,
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  read: new CommandSpec({
    description: 'Read a line from standard input into variables.',
    arguments: [
      new Argument('-r', {
        action: 'store_true',
        help: 'Raw mode: backslash is not an escape character.',
      }),
      new Argument('-a', { help: 'Store the words in the named array.' }),
      new Argument('-d', { help: 'Read up to this character.' }),
      new Argument('-n', { help: 'Return after at most N characters.' }),
      new Argument('-N', { help: 'Return after exactly N characters.' }),
      new Argument('-t', { help: 'Time out after N seconds.' }),
      new Argument('-p', { help: 'Prompt (terminal only).' }),
      new Argument('-s', { action: 'store_true', help: 'Do not echo (terminal only).' }),
      new Argument('-e', { action: 'store_true', help: 'Use readline (terminal only).' }),
      new Argument('-i', { help: 'Initial text (terminal only).' }),
      new Argument('-u', { help: 'Read from this descriptor.' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  mapfile: new CommandSpec({
    description: 'Read lines from standard input into an array.',
    arguments: [
      new Argument('-d', { help: 'Line delimiter instead of newline.' }),
      new Argument('-n', { help: 'Copy at most N lines.' }),
      new Argument('-O', { help: 'Start storing at this index.' }),
      new Argument('-s', { help: 'Discard the first N lines.' }),
      new Argument('-t', { action: 'store_true', help: 'Strip the delimiter.' }),
      new Argument('-u', { help: 'Read from this descriptor.' }),
      new Argument('-C', { help: 'Call this every quantum lines.' }),
      new Argument('-c', { help: 'Lines between callback calls.' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
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
 * the parse only reports what went wrong. An optional-value option given
 * bare is `true` in `flags`; `given` lists every option in the order it
 * was given, for a builtin whose options act in turn (xargs -I, -L and
 * -n cancel one another). `candidates` names the long options an
 * ambiguous abbreviation in `invalid` could mean, in declaration order,
 * and is empty when `invalid` names none. `needsValue` is the short
 * char, or the long token with its dashes; `unexpectedValue` is a
 * no-argument long option given a value, as its full spelling and the
 * value (`--null=x`).
 */
export interface ShellParse {
  flags: Record<string, string | boolean>
  given: [string, string | boolean][]
  operands: string[]
  invalid: string | null
  candidates: readonly string[]
  needsValue: string | null
  unexpectedValue: string | null
}

type ShellRefusal = Partial<
  Pick<ShellParse, 'invalid' | 'candidates' | 'needsValue' | 'unexpectedValue'>
>

/**
 * Scan leading options the way getopt does for a shell builtin.
 *
 * An optional-value option takes its value only when attached (`-iR`,
 * `--replace=R`), as getopt's `::` does, and a long option may be
 * abbreviated to any prefix that names one option, as getopt_long reads
 * it; an empty name (`--=x`) prefixes every one.
 */
export function parseShellOptions(spec: CommandSpec, argv: readonly string[]): ShellParse {
  const shortBool = new Set<string>()
  const shortValue = new Set<string>()
  const shortOptional = new Set<string>()
  const longBool = new Set<string>()
  const longValue = new Set<string>()
  const longOptional = new Set<string>()
  const alias = new Map<string, string>()
  for (const opt of compileSpec(spec).options) {
    const [shortName, longName] = optionSpellings(opt)
    const short = shortName?.replace(/^-+/, '') ?? null
    const long = longName?.replace(/^-+/, '') ?? null
    const name = short ?? long ?? ''
    if (short !== null) {
      ;(opt.action === 'store_true' || opt.action === 'count'
        ? shortBool
        : opt.nargs === '?'
          ? shortOptional
          : shortValue
      ).add(short)
      alias.set(short, name)
    }
    if (long !== null) {
      ;(opt.action === 'store_true' || opt.action === 'count'
        ? longBool
        : opt.nargs === '?'
          ? longOptional
          : longValue
      ).add(long)
      alias.set(long, name)
    }
  }
  const compiled = compileSpec(spec)
  const flags: Record<string, string | boolean> = {}
  const given: [string, string | boolean][] = []
  const record = (key: string, value: string | boolean): void => {
    flags[key] = value
    given.push([key, value])
  }
  const done = (operands: readonly string[], refusal: ShellRefusal = {}): ShellParse => ({
    flags,
    given,
    operands: [...operands],
    invalid: null,
    candidates: [],
    needsValue: null,
    unexpectedValue: null,
    ...refusal,
  })
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
      const typed = eq >= 0 ? tok.slice(0, eq) : tok
      const matches = typed === '--' ? compiled.longSpellings : expandLong(compiled, typed)
      const match = matches[0]
      if (matches.length !== 1 || match === undefined) {
        return done(argv.slice(i + 1), { invalid: tok, candidates: matches })
      }
      const name = match.slice(2)
      if (longBool.has(name)) {
        if (eq >= 0) {
          return done(argv.slice(i + 1), { unexpectedValue: `--${name}=${tok.slice(eq + 1)}` })
        }
        record(alias.get(name) ?? name, true)
      } else if (longOptional.has(name)) {
        record(alias.get(name) ?? name, eq >= 0 ? tok.slice(eq + 1) : true)
      } else if (longValue.has(name)) {
        if (eq >= 0) {
          record(alias.get(name) ?? name, tok.slice(eq + 1))
        } else {
          const value = argv[i + 1]
          if (value === undefined) return done(argv.slice(i + 1), { needsValue: `--${name}` })
          i += 1
          record(alias.get(name) ?? name, value)
        }
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
          record(alias.get(ch) ?? ch, true)
          j += 1
          continue
        }
        if (shortOptional.has(ch)) {
          const attached = chars.slice(j + 1)
          record(alias.get(ch) ?? ch, attached === '' ? true : attached)
          break
        }
        if (shortValue.has(ch)) {
          const rest = chars.slice(j + 1)
          if (rest !== '') {
            record(alias.get(ch) ?? ch, rest)
          } else {
            const value = argv[i + 1]
            if (value === undefined) {
              return done(argv.slice(i + 1), { needsValue: ch })
            }
            i += 1
            record(alias.get(ch) ?? ch, value)
          }
          break
        }
        return done(argv.slice(i + 1), { invalid: ch })
      }
      i += 1
      continue
    }
    break
  }
  return done(argv.slice(i))
}
