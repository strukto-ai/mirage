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

import { ShellArray } from '../../shell/array.ts'
import { encodeText } from '../../shell/bytes.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import type { ShellValue, ShellVar } from '../../shell/variable.ts'
import { createAsyncContext } from '../../utils/async_context.ts'
import { byteLength } from '../../utils/sanitize.ts'
import { ENV_EXHAUSTED_STATUS } from './constants.ts'
import type { SessionState } from './session.ts'

// The running workspace's max_env, null for no cap.
const limits = createAsyncContext<number | null>()

// Each variable record's bytes, counted once: a record never changes.
const varBytes = new WeakMap<ShellVar, number>()

/**
 * `fn` run under a workspace's max_env, which every write to a session's
 * shell state is checked against. Mirrors Python's `run_with_env_limit`.
 */
export function runWithEnvLimit<T>(limit: number | null, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(limits.run(limit, fn))
}

/**
 * The running workspace's max_env, null for no cap. A browser cannot tell one
 * task's binding from another's, so there it is the least any live line has.
 */
function envLimit(): number | null {
  let limit: number | null = null
  for (const live of limits.liveStores()) {
    if (live !== null) limit = Math.min(limit ?? Infinity, live)
  }
  return limit
}

/**
 * The bytes one name and its value hold: a variable, a function and its
 * body, or an alias and its text. An array element counts one byte more, so
 * an empty one is not free.
 */
export function entryBytes(name: string, value: ShellValue | null | undefined): number {
  let held = 0
  if (typeof value === 'string') held = byteLength(value)
  else if (value instanceof ShellArray) {
    for (const item of value.elements.values()) held += byteLength(item) + 1
  } else if (value !== null && value !== undefined) {
    for (const [key, item] of Object.entries(value)) {
      held += byteLength(key) + byteLength(item) + 1
    }
  }
  return byteLength(name) + held
}

/**
 * The bytes a list of positional parameters holds, one more for each, so an
 * empty one is not free.
 */
export function argsBytes(args: readonly string[]): number {
  let held = 0
  for (const arg of args) held += byteLength(arg) + 1
  return held
}

/**
 * The bytes the frames on a call stack hold in positional parameters, which
 * `envBytes` does not count. Mirrors Python's `frames_bytes`.
 */
export function framesBytes(callStack: CallStack): number {
  let held = 0
  for (const args of callStack.positionals()) held += argsBytes(args)
  return held
}

function recordBytes(name: string, record: ShellVar): number {
  let held = varBytes.get(record)
  if (held === undefined) {
    held = entryBytes(name, record.value) - byteLength(name)
    varBytes.set(record, held)
  }
  return byteLength(name) + held
}

/**
 * The bytes a session's shell state holds: its variables, functions,
 * aliases and positional parameters, names and values.
 */
export function envBytes(session: SessionState): number {
  let held = argsBytes(session.positionalArgs)
  for (const [name, record] of Object.entries(session.vars)) held += recordBytes(name, record)
  for (const [name, body] of Object.entries(session.functions)) held += entryBytes(name, body)
  for (const [name, text] of Object.entries(session.aliases)) held += entryBytes(name, text)
  return held
}

/**
 * Refuse a session whose shell state is past max_env before it runs a line:
 * what the workspace's `env`, a profile's `env` or a snapshot gave it, which
 * no write grew. `added` is bytes the session gains before it starts, such as
 * the workspace's `env` entries a stored record lacks. Mirrors Python's
 * `check_env_fits`.
 */
export function checkEnvFits(session: SessionState, limit: number | null, added = 0): void {
  const held = envBytes(session) + added
  if (limit !== null && held > limit) {
    throw new Error(
      `session '${session.sessionId}' starts with ${String(held)} bytes of ` +
        `shell state, past max_env of ${String(limit)} bytes`,
    )
  }
}

/**
 * Refuse a write that grows a session's shell state past max_env, from
 * `before` to `after` bytes for the entry written. Bash fails as it does when
 * it cannot allocate, a fatal error, and the message says the bound is a
 * setting, so an agent does not take it for a broken shell. A write that does
 * not grow passes unchecked. `held` is bytes the session holds outside what
 * `envBytes` counts, such as a function's own positional parameters. Mirrors
 * Python's `check_env`.
 */
export function checkEnv(session: SessionState, before: number, after: number, held = 0): void {
  const limit = envLimit()
  if (limit === null || after <= before) return
  if (envBytes(session) + held - before + after > limit) {
    throw new ExitSignal(
      ENV_EXHAUSTED_STATUS,
      encodeText(
        `bash: xmalloc: cannot allocate ${String(after)} bytes (past max_env of ` +
          `${String(limit)} bytes, a mirage workspace setting)\n`,
      ),
    )
  }
}
