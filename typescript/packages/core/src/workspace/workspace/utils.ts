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

import type { Process } from '../../execution/process/types.ts'
import { varsFromEnv } from '../session/session.ts'
import type { SessionState } from '../session/session.ts'

/** First word of a command line, the name diagnostics report ('' when blank). */
export function commandName(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ''
}

/**
 * Session a single `shell` call runs in.
 *
 * A per-call `cwd`/`env` runs in an ephemeral clone, matching a bash
 * subshell: `cd` and `export` inside the line do not leak back to the
 * persistent session. Without overrides the persistent session is used
 * as is.
 */
export function forkForCall(
  session: SessionState,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): SessionState {
  if (cwd === undefined && env === undefined) return session
  return session.fork({
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined
      ? { vars: { ...Object.fromEntries(session.vars.records()), ...varsFromEnv(env) } }
      : {}),
  })
}

/**
 * The pid and those of every process it started, followed through each
 * record's parent.
 */
export function processTree(records: readonly Process[], pid: number): Set<number> {
  const children = new Map<number, number[]>()
  for (const record of records) {
    if (record.parent === null) continue
    const siblings = children.get(record.parent) ?? []
    siblings.push(record.id.pid)
    children.set(record.parent, siblings)
  }
  const tree = new Set<number>()
  const todo = [pid]
  for (let current = todo.pop(); current !== undefined; current = todo.pop()) {
    if (tree.has(current)) continue
    tree.add(current)
    todo.push(...(children.get(current) ?? []))
  }
  return tree
}
