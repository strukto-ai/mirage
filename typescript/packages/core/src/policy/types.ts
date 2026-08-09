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

import type { Limit, PathSpec, Producer } from '../types.ts'

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
 * state an opinion or null to stay silent. Deny refuses (first opinion
 * wins); Limit bounds (every opinion merges to the tightest,
 * Limit.aggr). Each hook accepts a fixed set of kinds (VALIDITY),
 * enforced at the seam.
 */
export type Action = Deny | Limit

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
  /**
   * Every path the line names: the positional operands first, then the
   * values of any path-valued flags. What a path-pattern guard matches on.
   */
  paths: readonly PathSpec[]
  /**
   * The positional operands alone. A rule that reads a slot by position
   * (mv's source, ln's target, tar's files) has to use this: with the flag
   * values mixed in, `tar -xf a.tar -C /mnt` would read the `-C`
   * destination as a file being archived.
   */
  operands?: readonly PathSpec[]
  /** Raw argv after the command name; hooks fire before flag parsing. */
  argv: readonly string[]
  cwd: string
  registry: MountRootQuery
}

/** Facts about one VFS op, as preOps hooks see it. Fires at the op
 * door (the dispatcher every access routes through, FUSE included),
 * before any backend or cache I/O. */
export interface OpsContext {
  op: string
  path: PathSpec
  write: boolean
  prefix: string
}

/** One completed VFS op, as postOps hooks see it; a Deny suppresses
 * the result. */
export interface OpsResultContext {
  op: string
  path: PathSpec
  write: boolean
  prefix: string
  result: unknown
}

/**
 * One finished execute() line, as postExecute hooks see it. Fires at
 * the workspace boundary before the line's output stream is
 * finalized, so a Limit returned here bounds what the caller sees.
 * `producer` is the provenance of the surviving stream (the rightmost
 * command, per shell semantics), with an empty command when no
 * dispatch site stamped one.
 */
export interface ExecuteResultContext {
  producer: Producer
  exitCode: number
}

export const VALIDITY: Readonly<
  Record<'preCommand' | 'preOps' | 'postOps' | 'postExecute', ReadonlySet<string>>
> = {
  preCommand: new Set(['deny']),
  preOps: new Set(['deny']),
  postOps: new Set(['deny', 'limit']),
  postExecute: new Set(['limit']),
}
