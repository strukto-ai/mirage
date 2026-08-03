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

import type { PathSpec } from '../types.ts'

/**
 * The one registry question policy hooks may ask. MountRegistry
 * satisfies this structurally; the narrow interface keeps this package
 * a leaf (no workspace imports), so the registry can host a Policies
 * instance without a cycle. Mirrors the Python MountRootQuery.
 */
export interface MountRootQuery {
  isMountRoot(path: string): boolean
}

/**
 * Refuse the command with a message on stderr. `kind` is the wire
 * discriminant shared with Python; `exitCode` 1 (the GNU spelling of
 * an operand-level refusal) when omitted.
 */
export interface Deny {
  kind: 'deny'
  /** Full stderr text, newline-terminated. */
  message: string
  exitCode?: number
}

/**
 * The closed vocabulary of policy answers: a hook returns an Action to
 * state an opinion or null to stay silent. Grows arm by arm as further
 * lifecycle hooks land; each hook accepts a fixed set of kinds
 * (VALIDITY), enforced at the seam.
 */
export type Action = Deny

/**
 * A declarative guard: refuse matching commands on matching paths.
 * The YAML `guards:` block and `Workspace({guards: [...]})` accept
 * this shape; `Policies.add` compiles it to a SpecPolicy. Patterns
 * match the absolute virtual path with `*` (any run, including `/`)
 * and `?` (any one character). Empty `commands` means every command;
 * empty `paths` refuses the command regardless of its operands.
 */
export interface GuardSpec {
  reason: string
  commands?: readonly string[]
  paths?: readonly string[]
}

/** Facts about one classified command, as preCommand hooks see it. */
export interface CommandContext {
  command: string
  paths: readonly PathSpec[]
  /** Raw argv after the command name; hooks fire before flag parsing. */
  argv: readonly string[]
  cwd: string
  registry: MountRootQuery
}

export const VALIDITY: Readonly<Record<'preCommand', ReadonlySet<string>>> = {
  preCommand: new Set(['deny']),
}
