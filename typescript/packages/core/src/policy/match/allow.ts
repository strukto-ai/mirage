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
import type { AdmissionRules, CommandContext } from '../types.ts'

/**
 * Whether a session's allow list has a pattern for a command name. A
 * profile without an allow list allows everything; a profile with one
 * allows the names its patterns start with, builtins included. Shell
 * functions are the caller's exemption, not this one's. Mirrors Python's
 * `head_allowed`.
 */
export function headAllowed(name: string, rules: AdmissionRules | null): boolean {
  return admissionMatcher(rules).ask('head_allowed', { name: units(name) }) === true
}
/**
 * The tokens a pattern reads: the entry point's normalization when it set one,
 * else the name and the raw argv (a context built by hand).
 */
export function lineTokens(ctx: CommandContext): readonly string[] {
  return (ctx.tokens?.length ?? 0) > 0 ? (ctx.tokens ?? []) : [ctx.command, ...ctx.argv]
}
/**
 * Whether the profile's allow list has a pattern for the whole line. A
 * word that is not a tool (`ctx.tool` cleared by the entry point: the agent's
 * own function, an executed path) is always allowed here; a deny rule
 * is the only thing that can refuse it.
 */
export function lineAllowed(ctx: CommandContext, rules: AdmissionRules | null): boolean {
  return (
    admissionMatcher(rules).ask('line_allowed', {
      tokens: lineTokens(ctx).map(units),
      tool: ctx.tool ?? true,
    }) === true
  )
}
