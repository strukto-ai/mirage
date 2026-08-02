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

import { HISTORY_PREFIX } from '../../resource/history/history.ts'
import type { Session } from '../session/session.ts'

/** First word of a command line, the name diagnostics report ('' when blank). */
export function commandName(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ''
}

/**
 * Session a single `execute` call runs in.
 *
 * A per-call `cwd`/`env` runs in an ephemeral clone, matching a bash
 * subshell: `cd` and `export` inside the line do not leak back to the
 * persistent session. Without overrides the persistent session is used
 * as is.
 */
export function forkForCall(
  session: Session,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): Session {
  if (cwd === undefined && env === undefined) return session
  return session.fork({
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env: { ...session.env, ...env } } : {}),
  })
}

/**
 * Mount prefixes a session is always allowed to touch.
 *
 * The synthetic scratch root (where text-processing commands like `wc`
 * without a path argument resolve), the device mount, and the history
 * view are infrastructure: they hold no user credentials, and rejecting
 * them would break common shell idioms or the history builtin. A
 * user-defined root mount is NOT infrastructure; sessions must be
 * granted `/` explicitly to touch it.
 */
export function infrastructurePrefixes(syntheticRoot: boolean): Set<string> {
  const prefixes = new Set<string>(['/dev', HISTORY_PREFIX])
  if (syntheticRoot) prefixes.add('/')
  return prefixes
}
