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
import type { AdmissionRules, CommandContext } from '../types.ts'
import { patternMatches } from './pattern.ts'

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
 * Whether a session can run a command at all: its allow list allows the
 * name and no rule refuses the bare command everywhere. A rule written
 * under one mount refuses it only on a line working inside that mount,
 * which the shell judges line by line, so the command still runs; one
 * written under `/` covers every line. Mirrors Python's `runs`.
 */
export function runs(name: string, rules: AdmissionRules | null): boolean {
  if (!headAllowed(name, rules)) return false
  if (rules === null) return true
  return !rules.deny.some(
    (rule) =>
      (rule.paths ?? []).length === 0 &&
      ['', '/'].includes(rule.mount ?? '') &&
      ((rule.commands ?? []).length === 0 ||
        (rule.commands ?? []).some((p) => patternMatches(p, [name]))),
  )
}
