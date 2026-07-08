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

import { ShellBuiltin } from '../shell/types.ts'
import type { MountRegistry } from './mount/registry.ts'
import type { Session } from './session/session.ts'

// Bash builtins the parser accepts but the executor cannot honor; they
// still route to the shell layer so the error names a capability gap.
export const UNSUPPORTED_BUILTINS: ReadonlySet<string> = new Set([
  'bg',
  'disown',
  'exec',
  'complete',
  'compgen',
  'ulimit',
])

export const NAMESPACE_COMMANDS: ReadonlySet<string> = new Set(['ln', 'readlink'])

const SHELL_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(ShellBuiltin),
  ...UNSUPPORTED_BUILTINS,
])

/**
 * The layer that consumes a command: a command belongs to the layer
 * whose state it mutates.
 *
 * The verdict drives both the dispatch branch and the word policy:
 * SESSION / NAMESPACE / FUNCTION words are shell-resolved (bash
 * contract: programs receive matches, never patterns); MOUNT words
 * keep glob patterns intact for backend pushdown; UNKNOWN words are
 * never resolved (the command fails, backend I/O for it is waste).
 */
export const Consumer = Object.freeze({
  SESSION: 'session',
  NAMESPACE: 'namespace',
  FUNCTION: 'function',
  MOUNT: 'mount',
  UNKNOWN: 'unknown',
} as const)

export type Consumer = (typeof Consumer)[keyof typeof Consumer]

export const SHELL_CONSUMERS: ReadonlySet<Consumer> = new Set([
  Consumer.SESSION,
  Consumer.NAMESPACE,
  Consumer.FUNCTION,
])

/**
 * Route a command name to the layer that consumes it.
 *
 * Order mirrors dispatch precedence: shell builtins shadow functions,
 * functions shadow mount commands, and a name nobody registers is
 * UNKNOWN (command not found).
 */
export function route(name: string, session: Session, registry: MountRegistry): Consumer {
  if (SHELL_NAMES.has(name)) return Consumer.SESSION
  if (NAMESPACE_COMMANDS.has(name)) return Consumer.NAMESPACE
  if (name in session.functions) return Consumer.FUNCTION
  if (registry.mountForCommand(name) !== null) return Consumer.MOUNT
  return Consumer.UNKNOWN
}
