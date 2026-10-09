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

import type { CommandContext, AdmissionRules } from '../types.ts'
import { patternMatches, patternReaches } from './pattern.ts'

/**
 * Whether a session can see one node of a program tree.
 *
 * A profile without an allow list hides nothing; a profile with one hides every
 * node no pattern of it reaches. Only a CLI's verbs can be narrowed this
 * way, and only because the walk canonicalizes them (an alias resolved,
 * the global options before the verb dropped) before any pattern is read.
 * A flag has no such normal form, so a pattern never means to speak about
 * one.
 */
export function nodeVisible(path: readonly string[], rules: AdmissionRules | null): boolean {
  if (rules?.allow == null) return true
  return rules.allow.some((p) => patternReaches(p, path))
}

/**
 * Whether a session can see a command at all. A profile without an allow
 * list hides nothing; a profile with one hides every name none of its
 * patterns start with, builtins included. Shell functions are the
 * caller's exemption, not this one's. The head-word case of
 * `nodeVisible`.
 */
export function headVisible(name: string, rules: AdmissionRules | null): boolean {
  return nodeVisible([name], rules)
}

/**
 * The tokens a pattern reads: the entry point's normalization when it set one,
 * else the name and the raw argv (a context built by hand).
 */
export function lineTokens(ctx: CommandContext): readonly string[] {
  return ctx.tokens !== undefined && ctx.tokens.length > 0 ? ctx.tokens : [ctx.command, ...ctx.argv]
}

/**
 * Whether the profile's allow list has a pattern for the whole line. A
 * word that is not a tool (`ctx.tool` cleared by the entry point: the agent's
 * own function, an executed path) is always allowed here; a deny rule
 * is the only thing that can refuse it.
 */
export function lineAllowed(ctx: CommandContext, rules: AdmissionRules | null): boolean {
  if (ctx.tool === false) return true
  if (rules?.allow == null) return true
  const tokens = lineTokens(ctx)
  return rules.allow.some((p) => patternMatches(p, tokens))
}
