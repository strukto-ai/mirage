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

import type { JobTable } from '../../execution/job/index.ts'
import type { LineHandle } from '../../execution/line/handle.ts'
import type { HandOff } from '../../policy/types.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import type { JobConsole } from '../../shell/console/index.ts'
import type { ParseScope } from '../../shell/parse/scope.ts'
import type { ExecuteFn } from '../expand/types.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { ExecuteNodeOpts } from './command/types.ts'

export interface ExecuteNodeDeps {
  /** @internal Scheduling scope; background jobs create their own. */
  lineHandle?: LineHandle
  dispatch: DispatchFn
  registry: MountRegistry
  namespace: Namespace
  jobTable: JobTable
  executeFn: ExecuteFn
  signal?: AbortSignal
  /**
   * The hand-off this subtree runs on, carried to every command's gate
   * so it runs on the grants claimed for this line and never another's,
   * and bound into `executeFn` by `withHandOff` so every line the
   * subtree evaluates stands under it too.
   */
  handed?: HandOff
  /**
   * The shell parser. Only alias expansion needs it: an alias rewrites the
   * head word textually and the result is read as a fresh line, so a value
   * holding a pipe is a pipe. Absent (a unit test driving the walker
   * directly) means an alias definition is stored and printed but never
   * expanded.
   */
  parser?: ParseScope
  /**
   * Console this node writes its output to as it is produced.
   * When set, the node emits and returns no stdout; when unset
   * it returns stdout as a value, which is what capture sites
   * (command substitution, pipe stages, redirects) rely on.
   */
  sink?: JobConsole
}

/**
 * The deps for a subtree that runs on `handed`.
 *
 * The hand-off a subtree's gates read and the one its nested
 * evaluations run under are one fact, set together here so the walker
 * can never carry one hand-off and evaluate under another. Everything a
 * command hands a line to (eval, source, xargs, command, a substitution,
 * a herestring, a redirect target) re-enters through `executeFn`, so the
 * hand-off is bound into it rather than into the line's closure: a
 * background job's subtree runs on a hand-off of the job's own, and a
 * line it evaluates after the typed line has ended has to stand under
 * that one. Under the line's, the inner gate could not see the grant the
 * job holds and asked again, and what it claimed went back to a hand-off
 * nothing revokes any more.
 */
export function withHandOff(deps: ExecuteNodeDeps, handed: HandOff): ExecuteNodeDeps {
  const inner = deps.executeFn
  const executeFn: ExecuteFn = (cmd, opts) => inner(cmd, { handed, ...opts })
  return { ...deps, handed, executeFn }
}

/**
 * Layer per-call overrides onto the walker's deps.
 *
 * Written field by field rather than spread so an explicitly undefined
 * override cannot erase a dep under exactOptionalPropertyTypes.
 */
export function withOpts(base: ExecuteNodeDeps, opts?: ExecuteNodeOpts): ExecuteNodeDeps {
  if (opts === undefined) return base
  let next: ExecuteNodeDeps = { ...base }
  if (opts.sink !== undefined) next.sink = opts.sink
  if (opts.signal !== undefined) next.signal = opts.signal
  if (opts.lineHandle !== undefined) next.lineHandle = opts.lineHandle
  if (opts.jobTable !== undefined) {
    // The lines the subtree runs (`eval`, `source`, an EXIT action) see
    // its job list too.
    const { jobTable } = opts
    const inner = next.executeFn
    next.jobTable = jobTable
    next.executeFn = (cmd, o) => inner(cmd, { jobTable, ...o })
  }
  if (opts.handed !== undefined) next = withHandOff(next, opts.handed)
  return next
}
