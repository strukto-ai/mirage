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

import { admissionMatcher, units } from '../../rs/policy.ts'
import type { AdmissionRules } from '../types.ts'

/**
 * Whether the profile states a command rule at all: an allow list, an ask
 * or a deny.
 */
export function hasRules(rules: AdmissionRules | null): boolean {
  return rules !== null && (rules.allow !== null || rules.ask.length > 0 || rules.deny.length > 0)
}
/**
 * Whether a rule in force reads a command's words past its name.
 *
 * The whole-line gate asks this for a word the runtime, not the gate,
 * will expand: the head of every command is read by every rule, but an
 * argument only matters to a pattern with a token after the name
 * (`git push`), a path-scoped rule, or a mount-scoped one, so a dynamic
 * argument to a command no such rule names is nothing a rule would have
 * seen anyway.
 */
export function readsArgs(rules: AdmissionRules | null, name: string): boolean {
  return rules !== null && admissionMatcher(rules).ask('reads_args', { name: units(name) }) === true
}
/**
 * Whether a path rule in force reads this command's paths.
 *
 * The argv builder asks this before deciding who resolves a glob
 * operand: a mount command's pattern is normally pushed down to the
 * backend, so the gate would see the pattern, not the matches, and
 * `cat /scratch/*\/k` would pass a rule on `/scratch/private` that
 * `cat /scratch/private/k` fails. When a rule that reads paths (or a
 * mount) applies to the command, whether it names the command or every
 * command, the shell expands the glob first, so the gate judges the
 * paths the command will touch.
 */
export function scopesPaths(rules: AdmissionRules | null, name: string): boolean {
  return (
    rules !== null && admissionMatcher(rules).ask('scopes_paths', { name: units(name) }) === true
  )
}
