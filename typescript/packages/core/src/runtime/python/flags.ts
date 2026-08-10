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

// The interpreter-init switches, keyed by CPython's own letter. These
// configure the interpreter rather than selecting what it runs, so they
// ride in RunArgs.flags and each engine answers the ones it can. `-u`
// and `-q` are deliberately absent: mirage buffers every stream and
// prints no banner, so they are structural no-ops in every runtime
// rather than something one engine honors and another does not.
const BOOL_FLAGS: readonly string[] = ['B', 'E', 'I', 's', 'S']
const LIST_FLAGS: readonly string[] = ['W', 'X']
const OPTIMIZE_FLAG = 'O'

/** One run's interpreter-init switches, as the command parsed them. */
export interface InitFlags {
  B?: boolean
  E?: boolean
  I?: boolean
  s?: boolean
  S?: boolean
  O?: number
  W?: readonly string[]
  X?: readonly string[]
}

/**
 * The init switches present on a line, in CPython's spelling.
 *
 * A runtime that cannot act on these reports them rather than dropping
 * them silently, so a line behaving differently across runtimes says so
 * instead of being discovered later.
 *
 * Args:
 *   flags: the run's RunArgs.flags bag.
 */
function unhonored(flags: InitFlags): string[] {
  const present: string[] = []
  for (const key of [...BOOL_FLAGS, OPTIMIZE_FLAG, ...LIST_FLAGS]) {
    const value = flags[key as keyof InitFlags]
    const set = Array.isArray(value) ? value.length > 0 : value === true || value === 1
    if (set) present.push(`-${key}`)
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
 * Args:
 *   flags: the run's RunArgs.flags bag.
 *   runtimeName: the engine's registry name, for the message.
 */
export function unhonoredNotice(flags: InitFlags, runtimeName: string): Uint8Array {
  const lines = unhonored(flags).map(
    (spelling) => `python3: warning: ${spelling} is ignored by the '${runtimeName}' runtime\n`,
  )
  return new TextEncoder().encode(lines.join(''))
}
