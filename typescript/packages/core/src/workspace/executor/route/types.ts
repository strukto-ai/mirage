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

import type { Deny, ExecuteContext, Route } from '../../../policy/types.ts'
import type { Runtime } from '../runtime.ts'

/**
 * Script source arriving from a workspace config, not from code.
 *
 * The programmatic API takes functions; a yaml `script:`/`policy:`
 * value references a `.py` file whose content is embedded here at
 * load. The source sees ctx as a dict and its LAST EXPRESSION is the
 * verdict. It runs on the policy engine (monty today; a sandbox
 * runtime is a candidate door later).
 */
export class ScriptSource {
  /**
   * `language` names the script's language ("python" or "js"), stamped
   * from the file extension at config load; the programmatic default
   * is "python". The policy engine prefers a matching evaluator.
   */
  constructor(
    readonly source: string,
    readonly language = 'python',
  ) {}
}

/**
 * A per-runtime willingness script, answering "do I want this line?".
 * In code: a function (sync or async) on the ExecuteContext returning a
 * truthy verdict. From config: a `.py` file reference, loaded as
 * ScriptSource (its last expression is the verdict).
 *
 * ```
 * new VfsRuntime({ script: (ctx) => ctx.builtin && !ctx.line.includes('/secret') })
 *
 * // workspace yaml: guard.py next to the config file
 * // runtimes:
 * //   - name: vfs
 * //     script: guard.py
 * ```
 */
export type PolicyScript = ((ctx: ExecuteContext) => boolean | Promise<boolean>) | ScriptSource

/**
 * What the routing policy may answer: an Action arm (Route places the
 * line, Deny refuses it, exit 126 with `<command>: policy denied:
 * <reason>` on stderr), a bare runtime name, null to pass, or the
 * verdict object (the wire spelling of the arms, the only form a
 * config script can return). Object keys are mutually exclusive:
 * `{runtime: name}` places the line, `{deny: reason}` refuses it. New
 * powers grow as arm fields and wire keys, never as new return types.
 * Mirrors the python PolicyVerdict.
 */
export type PolicyVerdict = Route | Deny | string | null | { runtime?: string; deny?: string }

/**
 * The routing policy, answering "who takes this line?". In code: a
 * function (sync or async) on the ExecuteContext returning a
 * PolicyVerdict. From config: a `.py` file reference, loaded as
 * ScriptSource (its last expression is the verdict).
 *
 * ```
 * policy: (ctx) => (ctx.command === 'python3' ? 'monty' : null)
 *
 * // workspace yaml: policy.py next to the config file
 * // policy: policy.py
 * ```
 */
export type PolicyFn =
  | ((ctx: ExecuteContext) => PolicyVerdict | Promise<PolicyVerdict>)
  | ScriptSource

/**
 * The one-line placement decision the dispatcher consults.
 *
 * Both fields hold runtimes: the decision IS "which runtime runs which
 * command". The vfs runtime is a legal value in either; a command
 * placed on it is served by the workspace executor itself.
 */
export interface PolicyDecision {
  /**
   * Every command some entry captures, resolved for this line: the
   * runtime it runs on, or null when its capturers all refused
   * (admission failure, exit 126, never a silent fallback to the
   * workspace).
   */
  bindings: Record<string, Runtime | null>
  /**
   * Where commands no entry captures run: the catch-all vfs runtime,
   * or null when the vfs runtime refused the line or declares
   * captures; unbound commands then exit 126.
   */
  fallback: Runtime | null
}
