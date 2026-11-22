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

import { units } from '../../rs/document.ts'
import { admissionMatcher } from '../../rs/policy.ts'
import { type AdmissionRules, Outcome, type ScopedTree } from '../types.ts'

/** Whether the profile states any command tree at all. */
export function hasRules(rules: AdmissionRules | null): boolean {
  return rules !== null && rules.trees.length > 0
}

function rootDenies(scoped: ScopedTree): boolean {
  return !scoped.mount && scoped.tree.decision.some((leaf) => leaf.decision === Outcome.DENY)
}

/**
 * Whether a top-level tree denies each line it names no command for: its
 * root's own decision is a deny.
 */
export function closedByDefault(rules: AdmissionRules | null): boolean {
  return rules?.trees.some(rootDenies) ?? false
}

/**
 * Whether a top-level tree denies every line: closed by default
 * (`closedByDefault`) and naming no command.
 */
export function closed(rules: AdmissionRules | null): boolean {
  return (
    rules?.trees.some(
      (scoped) =>
        rootDenies(scoped) && scoped.tree.subcommands.size === 0 && scoped.tree.operands.size === 0,
    ) ?? false
  )
}

/**
 * Whether a tree in force reads a command's words past its name.
 *
 * The whole-line gate asks this for a word the runtime, not the gate,
 * will expand: the head of every command is read by every tree, but an
 * argument only matters to a node below the command (a subcommand, an
 * option, an operand) or a folder entry's tree, so a
 * dynamic argument to a command no such node names is nothing a tree
 * would have seen anyway.
 */
export function readsArgs(rules: AdmissionRules | null, name: string): boolean {
  return rules !== null && admissionMatcher(rules).ask('reads_args', { name: units(name) }) === true
}

/**
 * Whether a folder entry's tree in force reads this command's paths.
 *
 * The argv builder asks this before deciding who resolves a glob
 * operand: a mount command's pattern is normally pushed down to the
 * backend, so the gate would see the pattern, not the matches, and
 * `cat /scratch/*\/k` would pass a folder entry for `/scratch/private`
 * that `cat /scratch/private/k` fails. When a folder entry's tree speaks
 * for the command, whether it names the command or every command, the
 * shell expands the glob first, so the gate judges the paths the command
 * will touch.
 */
export function scopesPaths(rules: AdmissionRules | null, name: string): boolean {
  return (
    rules !== null && admissionMatcher(rules).ask('scopes_paths', { name: units(name) }) === true
  )
}
