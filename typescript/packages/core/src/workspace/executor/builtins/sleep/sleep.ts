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

import { helpPage, versionLine } from '../../../../commands/config.ts'
import { quoteText } from '../../../../commands/quote.ts'
import { specOf } from '../../../../commands/spec/index.ts'
import { NUMERIC_SHORT } from '../../../../commands/spec/constants.ts'
import {
  ambiguousOptionError,
  unexpectedValueError,
  unknownOptionError,
  usageHint,
} from '../../../../commands/spec/usage.ts'
import { yieldBytes } from '../../../../io/stream.ts'
import { IOResult } from '../../../../io/types.ts'
import { sleep } from '../../../abort.ts'
import { ExecutionNode } from '../../../types.ts'
import { SLEEP_INTERVAL, SLEEP_SUFFIXES } from './constants.ts'
import type { BuiltinCall, Result } from '../types.ts'

// The only two options coreutils sleep declares, through gnulib's
// `parse_gnu_standard_options_only`. They share no prefix, so an abbreviation
// of either resolves and neither can ever be ambiguous.
const STANDARD_OPTIONS = ['--help', '--version'] as const

/**
 * The standard options a long spelling names, declaration order.
 *
 * getopt_long takes an exact word outright and otherwise keeps every candidate
 * the word prefixes, so `sleep --h` is one match (help, exit 0) and
 * `sleep --=x` is an empty name that prefixes both, which GNU refuses as
 * ambiguous. Measured on 9.7. `_standard_matches` in sleep.py is the twin.
 */
function standardMatches(name: string): string[] {
  const exact = STANDARD_OPTIONS.find((word) => word === name)
  if (exact !== undefined) return [exact]
  return STANDARD_OPTIONS.filter((word) => word.startsWith(name))
}

/**
 * sleep's answer to `--help` or `--version`: stdout, exit 0.
 *
 * The page is built by `helpPage`, the one function every registered
 * command's `--help` goes through (commands/config.ts), so the two cannot
 * drift. That matters here because sleep is a shell builtin rather than a
 * registered command: nothing injects the two standard options into its
 * spec, so rendering that spec directly produced a page documenting neither
 * of the options this arm exists to answer, under a synthesized
 * `sleep [<text>...]` in place of GNU's own `sleep NUMBER[SUFFIX]...`.
 */
function standardResponse(option: string): Result {
  const text = option === '--help' ? helpPage('sleep', specOf('sleep')) : versionLine('sleep')
  return [
    yieldBytes(new TextEncoder().encode(text)),
    new IOResult(),
    new ExecutionNode({ command: 'sleep', exitCode: 0 }),
  ]
}

/**
 * sleep's operands, and the first dash word that is not one.
 *
 * coreutils sleep declares only gnulib's two standard options and reads the
 * line through a real getopt_long loop (`parse_gnu_standard_options_only`), so
 * it stops at a dash-leading word wherever that word sits: measured on 9.4,
 * `sleep --zzz 0` and `sleep 0 --zzz` both report the option and neither
 * reports the interval. The caller decides what that word means, since a
 * `--help`/`--version` spelling is an answer rather than a refusal. `--` ends
 * the scan, which is what makes `sleep -- '--zzz=é'` an interval diagnostic
 * instead of an option one, and a `-<digits>` word stays an operand --
 * mirage's NUMERIC_SHORT rule, which every command shares, and the reason
 * `sleep -1` names the interval where GNU names the option letter.
 *
 * The returned word is the whole token for a long spelling and the offending
 * letter for a short one, the split `unknownOptionError` already words.
 *
 * `_sleep_operands` in sleep.py is the twin.
 */
function sleepOperands(args: string[]): [string[], string | null] {
  const operands: string[] = []
  for (const [index, arg] of args.entries()) {
    if (arg === '--') {
      operands.push(...args.slice(index + 1))
      break
    }
    if (arg.startsWith('-') && arg.length > 1 && !NUMERIC_SHORT.test(arg)) {
      return [operands, arg.startsWith('--') ? arg : (arg[1] ?? arg)]
    }
    operands.push(arg)
  }
  return [operands, null]
}

/**
 * One operand's seconds, or null when it is not an interval.
 *
 * GNU's grammar is `NUMBER[SUFFIX]`, which the help page advertises: gnulib
 * reads the number with strtod, then allows at most ONE trailing character and
 * looks it up in `apply_suffix`. Measured on coreutils 9.7: `sleep 0.005m`
 * takes 0.3s, `sleep 1e-3s` is accepted, and `sleep 0S`, `sleep 0ss`,
 * `sleep 0sx` and `sleep s` are each `invalid time interval`. Null also covers
 * GNU's own "inf", a documented divergence carried by SLEEP_INTERVAL.
 * `_interval_seconds` in sleep.py is the twin.
 */
function intervalSeconds(raw: string): number | null {
  const multiplier = SLEEP_SUFFIXES[raw.slice(-1)] ?? 0
  const num = multiplier ? raw.slice(0, -1) : raw
  if (!SLEEP_INTERVAL.test(num)) return null
  const seconds = Number(num) * (multiplier || 1)
  // "1e309" passes the regex and overflows to Infinity.
  return Number.isFinite(seconds) ? seconds : null
}

export async function handleSleep(args: string[], signal?: AbortSignal): Promise<Result> {
  const [operands, badOption] = sleepOperands(args)
  if (badOption !== null) {
    // The scan stops at the first dash word, and that word decides the whole
    // line: `sleep --help --zzz` is help and `sleep --zzz --help` is the
    // refusal (measured on 9.7). A long spelling is first offered to the two
    // standard options, which are real getopt_long options, so an abbreviation
    // resolves and a value on one is refused for the VALUE rather than as an
    // unknown option (`sleep --hel=x` is `option '--help' doesn't allow an
    // argument`).
    const eq = badOption.indexOf('=')
    const name = eq === -1 ? badOption : badOption.slice(0, eq)
    const matches = name.startsWith('--') ? standardMatches(name) : []
    const sole = matches[0]
    if (sole !== undefined && matches.length === 1 && eq === -1) {
      return standardResponse(sole)
    }
    // `--=x` is an empty long name, which prefixes both, and getopt_long
    // quotes the WHOLE token here where the doesn't-allow-an-argument refusal
    // quotes the canonical spelling.
    const [message, code] =
      matches.length > 1
        ? ambiguousOptionError('sleep', badOption, matches)
        : sole !== undefined
          ? unexpectedValueError('sleep', sole)
          : unknownOptionError('sleep', badOption)
    return [
      null,
      new IOResult({ exitCode: code, stderr: message }),
      new ExecutionNode({ command: 'sleep', exitCode: code }),
    ]
  }
  if (operands.length === 0) {
    // Missing operand is the same `usage (EXIT_FAILURE)` refusal the
    // invalid-interval one is, so it carries the same Try-help line (measured
    // on 9.4: `sleep` is two lines, not one).
    const err = new TextEncoder().encode(`sleep: missing operand\n${usageHint('sleep')}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'sleep', exitCode: 1 }),
    ]
  }
  // `NUMBER[SUFFIX]...`: every operand is an interval and the line sleeps
  // their SUM (measured on 9.7: `sleep 0.3 0.3` takes 0.6s). All of them are
  // checked before any of them is slept, so a bad one anywhere refuses the
  // whole line immediately rather than after sleeping its predecessors
  // (`sleep 0.2 x 0.2` exits 1 at once).
  let total = 0
  const bad: string[] = []
  for (const raw of operands) {
    const seconds = intervalSeconds(raw)
    if (seconds === null) {
      bad.push(raw)
      continue
    }
    // The SUM is what gets slept, so an operand that carries it past the
    // representable range is refused exactly like one that is not finite on
    // its own: `sleep 1e308 1e308` overflows to Infinity, and an infinite
    // total slipped past the check each operand passes alone. GNU sleeps
    // forever on it (measured on 9.7, as it does on `sleep inf`); refusing it
    // is the same deliberate divergence SLEEP_INTERVAL already carries, for
    // the same reason.
    if (!Number.isFinite(total + seconds)) {
      bad.push(raw)
      continue
    }
    total += seconds
  }
  if (bad.length > 0) {
    // coreutils calls `error()` per offending operand and only then
    // `usage (EXIT_FAILURE)`, so EVERY bad operand is named, in line order and
    // repeated if it repeats, under one closing Try-help line (measured on
    // 9.7: `sleep 1x 2y` is three lines, `sleep 1x 1x` names 1x twice). Each
    // operand goes through gnulib's `quote()` like every other coreutils
    // operand diagnostic (measured on 9.4: `sleep -- é` names `'\303\251'`).
    const lines = bad.map((raw) => `sleep: invalid time interval '${quoteText(raw)}'\n`)
    const err = new TextEncoder().encode(`${lines.join('')}${usageHint('sleep')}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'sleep', exitCode: 1 }),
    ]
  }
  await sleep(total * 1000, signal)
  return [null, new IOResult(), new ExecutionNode({ command: 'sleep', exitCode: 0 })]
}

/** The `sleep` arm; the abort signal ends the wait early. */
export async function sleepBuiltin(call: BuiltinCall): Promise<Result> {
  return handleSleep([...call.argv.args], call.signal)
}
