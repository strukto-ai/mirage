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

import type { FlagValue } from '../../commands/spec/types.ts'

// The interpreter-init switches, keyed by CPython's own letter. These
// configure the interpreter rather than selecting what it runs, so they
// ride in the run's `ctx.flags` and each engine answers the ones it can. `-u`
// and `-q` are deliberately absent: mirage buffers every stream and
// prints no banner, so they are structural no-ops in every runtime
// rather than something one engine honors and another does not.
const BOOL_FLAGS: readonly string[] = ['B', 'E', 'I', 'P', 's', 'S']
const COUNT_FLAGS: readonly string[] = ['O', 'b']
const LIST_FLAGS: readonly string[] = ['W', 'X']
// The one init switch CPython spells long. Its key is the parser's
// canonical spelling rather than a letter, since it has none.
const VALUE_FLAGS: Readonly<Record<string, string>> = {
  check_hash_based_pycs: '--check-hash-based-pycs',
}

// The -X names CPython gives an effect beyond landing in
// sys._xoptions, so a warm interpreter that only populates that dict
// has not honored them. Every one is read out of the read-only
// sys.flags or installed at interpreter start (dev, utf8,
// warn_default_encoding, importtime, frozen_modules, cpu_count,
// no_debug_ranges, perf*, showrefcount) or needs a library call this
// wrapper does not make (faulthandler, int_max_str_digits,
// pycache_prefix, tracemalloc). An arbitrary name is deliberately
// absent: on CPython it does nothing but land in the dict either.
// Pinned against `python3 --help-xoptions` on 3.13.7.
const X_EFFECTS: ReadonlySet<string> = new Set([
  'cpu_count',
  'dev',
  'faulthandler',
  'frozen_modules',
  'importtime',
  'int_max_str_digits',
  'no_debug_ranges',
  'perf',
  'perf_jit',
  'pycache_prefix',
  'showrefcount',
  'tracemalloc',
  'utf8',
  'warn_default_encoding',
])

/**
 * A counted switch's level; 0 when absent.
 *
 * @param value the switch's value.
 */
function count(value: FlagValue | undefined): number {
  return typeof value === 'number' ? value : 0
}

/**
 * A repeated switch's values; none when absent.
 *
 * @param value the switch's value.
 */
function words(value: FlagValue | undefined): string[] {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item : item.virtual))
    : []
}

/**
 * CPython command-line switches for one run's interpreter flags.
 *
 * For the engines that spawn a real interpreter, honoring these is just
 * handing them back to CPython in its own spelling. `-O` and `-b` repeat
 * rather than taking a number, so level 2 is `-O -O`, which CPython reads
 * exactly as `-OO`. Mirrors Python's init_argv.
 *
 * @param flags the run's interpreter switches (`ctx.flags`).
 */
export function initArgv(flags: Readonly<Record<string, FlagValue>>): string[] {
  const argv: string[] = []
  for (const key of BOOL_FLAGS) {
    if (flags[key] === true) argv.push(`-${key}`)
  }
  for (const key of COUNT_FLAGS) {
    for (let i = 0; i < count(flags[key]); i++) argv.push(`-${key}`)
  }
  for (const key of LIST_FLAGS) {
    for (const value of words(flags[key])) argv.push(`-${key}`, value)
  }
  for (const [key, spelling] of Object.entries(VALUE_FLAGS)) {
    const setting = flags[key]
    // CPython parses this one by hand and rejects --opt=value, so it
    // goes back as two words whatever the user typed.
    if (typeof setting === 'string' && setting !== '') argv.push(spelling, setting)
  }
  return argv
}

/**
 * The init switches present on a line that this engine did not act on.
 *
 * A runtime that cannot act on these reports them rather than dropping
 * them silently, so a line behaving differently across runtimes says so
 * instead of being discovered later. `honored` is the engine's own
 * subset, by CPython letter; the default is none, which is the honest
 * answer for an engine that is not CPython at all.
 *
 * @param flags the run's interpreter switches (`ctx.flags`).
 * @param honored the letters this engine does act on.
 */
function unhonored(
  flags: Readonly<Record<string, FlagValue>>,
  honored: readonly string[],
): string[] {
  const present: string[] = []
  for (const key of [...BOOL_FLAGS, ...COUNT_FLAGS, ...LIST_FLAGS]) {
    if (honored.includes(key)) continue
    const value = flags[key]
    const set = Array.isArray(value) ? value.length > 0 : value === true || count(value) > 0
    if (set) present.push(`-${key}`)
  }
  for (const [key, spelling] of Object.entries(VALUE_FLAGS)) {
    if (honored.includes(key)) continue
    if (flags[key]) present.push(spelling)
  }
  // Reported per name rather than per letter: an engine can honor what
  // -X means for sys._xoptions and still not act on the handful of
  // names CPython gives a real effect.
  for (const value of words(flags.X)) {
    const optName = value.split('=')[0] ?? ''
    if (X_EFFECTS.has(optName) && !honored.includes(`X:${optName}`)) {
      present.push(`-X ${optName}`)
    }
  }
  return present
}

/**
 * One stderr line per init switch this runtime cannot act on.
 *
 * A warning rather than a refusal: the line still runs and still
 * reports the program's own exit code, so a script that works on every
 * other runtime keeps working here, while the difference stays visible
 * instead of being found later.
 *
 * @param flags the run's interpreter switches (`ctx.flags`).
 * @param runtimeName the engine's registry name, for the message.
 * @param honored the letters this engine does act on.
 */
export function unhonoredNotice(
  flags: Readonly<Record<string, FlagValue>>,
  runtimeName: string,
  honored: readonly string[] = [],
): Uint8Array {
  const lines = unhonored(flags, honored).map(
    (spelling) => `python3: warning: ${spelling} is ignored by the '${runtimeName}' runtime\n`,
  )
  return new TextEncoder().encode(lines.join(''))
}
