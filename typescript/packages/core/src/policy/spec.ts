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

import type { Policy } from './base.ts'
import type { Action, CommandContext, GuardSpec, OpsContext } from './types.ts'

/**
 * Compile a `*`/`?` wildcard into an anchored regex. Deliberately not
 * a full glob: both languages support exactly these two
 * metacharacters, so a pattern means the same thing in Python and
 * TypeScript.
 */
export function wildcardRegex(pattern: string): RegExp {
  let out = '^'
  for (const ch of pattern) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

/** A GuardSpec compiled to a policy. */
export class SpecPolicy implements Policy {
  readonly spec: GuardSpec
  private readonly patterns: RegExp[]

  constructor(spec: GuardSpec) {
    this.spec = spec
    this.patterns = (spec.paths ?? []).map(wildcardRegex)
  }

  preCommand(ctx: CommandContext): Action | null {
    const commands = this.spec.commands ?? []
    if (commands.length > 0 && !commands.includes(ctx.command)) return null
    if (this.patterns.length === 0) {
      return { kind: 'deny', message: `${ctx.command}: ${this.spec.reason}\n`, exitCode: 1 }
    }
    for (const p of ctx.paths) {
      for (const pattern of this.patterns) {
        if (pattern.test(p.virtual)) {
          const display = p.rawPath || p.virtual
          return {
            kind: 'deny',
            message: `${ctx.command}: ${display}: ${this.spec.reason}\n`,
            exitCode: 1,
          }
        }
      }
    }
    return null
  }

  preOps(ctx: OpsContext): Action | null {
    // The op-layer twin: pure path protection (no command scope) also
    // holds at the op door, so FUSE, programmatic ops, and the warm
    // cache cannot bypass it. Command-scoped specs stay command-layer:
    // an op does not know which command issued it.
    const commands = this.spec.commands ?? []
    if (commands.length > 0 || this.patterns.length === 0) return null
    for (const pattern of this.patterns) {
      if (pattern.test(ctx.path.virtual)) {
        return { kind: 'deny', message: `${this.spec.reason}\n`, exitCode: 1 }
      }
    }
    return null
  }
}
