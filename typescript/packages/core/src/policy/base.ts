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

import type { RouteContext } from './types.ts'
import type {
  Action,
  CommandContext,
  CommandResultContext,
  ExecuteResultContext,
  VfsContext,
  VfsResultContext,
  SessionContext,
  SessionResultContext,
} from './types.ts'

/**
 * One concern's answers to the workspace lifecycle.
 *
 * Implementations define only the hooks they care about; a hook
 * returns an Action to state an opinion or null to stay silent
 * (directly or as a promise; the seam awaits either), and a hook that
 * throws fails closed (the command is refused, naming the policy).
 * Undefined hooks are detected at the seam and never called.
 *
 * The hooks come in pairs, one per surface: the line (`preExecute` /
 * `postExecute`), each command or CLI (`preCommand` / `postCommand`),
 * each `ws.vfs` / `session.vfs` call (`preVfs` / `postVfs`) and each
 * session write (`preSession` / `postSession`). Every hook may answer
 * Deny or Ask; a Limit only where a result comes back to cap (`postVfs`,
 * `postExecute`), a Route only at `preExecute`. A post hook sees what
 * its pre hook saw, plus what came back, and never undoes a side effect:
 * it holds back what came back. Hides, mount modes and path rules are
 * not hooks: they apply to every caller at the dispatcher. Every hook's
 * context also carries the session (`session`), its namespace (`ns`) and
 * its files (`vfs`), all read only: a hook reads, and a write it makes is
 * refused. Mirrors the Python Policy.
 */
export interface Policy {
  /**
   * Place, hold or refuse one typed line before any of it runs. Fires
   * once per line, after the profile's rules clear it (a line they
   * refuse is never placed) and before it runs; a nested line keeps the
   * placement of the line that ran it. A Route names the runtime that
   * serves the line, a Deny refuses it whole (exit 126,
   * `<command>: Permission denied`) and an Ask holds it until the host
   * approves. The workspace's `routePolicy` answers here as a built-in,
   * ahead of the policies registered in code.
   */
  preExecute?(ctx: RouteContext): Action | null | Promise<Action | null>
  /**
   * Admit, hold or refuse one command or CLI, once, as it runs. A Deny
   * refuses it (`<command>: Permission denied`, exit 126, or the
   * operand's own error for an operand refusal); an Ask holds it until
   * the host approves. Its own file I/O meets the hides, the mount mode
   * and the profile's path rules, never `preVfs`.
   */
  preCommand?(ctx: CommandContext): Action | null | Promise<Action | null>
  /**
   * Judge one command or CLI once it ran and its output drained. A Deny,
   * or an Ask the host has not approved, sets its exit code to 126 and
   * records the refusal, so `&&` and `pipefail` stop there; output
   * already sent stays sent.
   */
  postCommand?(ctx: CommandResultContext): Action | null | Promise<Action | null>
  /**
   * Admit, hold or refuse one `ws.vfs` / `session.vfs` call. Fires at the
   * dispatcher before any backend or cache I/O, for the host's and the
   * agent's file calls (and FUSE): never for a running line's own I/O,
   * which `preCommand` judged. A Deny is EACCES; an Ask holds the call
   * until the host approves.
   */
  preVfs?(ctx: VfsContext): Action | null | Promise<Action | null>
  /**
   * Judge one completed `ws.vfs` / `session.vfs` call. A Deny, or an Ask
   * the host has not approved, drops the result with EACCES (the call
   * itself is not undone); a Limit caps a byte-producing one.
   */
  postVfs?(ctx: VfsResultContext): Action | null | Promise<Action | null>
  /**
   * Admit, hold or refuse one session write (set, unset, mark) on the
   * session plane, before it lands. Not path-scoped on purpose: the
   * context carries a key, never a pseudo-path.
   */
  preSession?(ctx: SessionContext): Action | null | Promise<Action | null>
  /**
   * Judge one session write once it landed. A Deny, or an Ask the host
   * has not approved, puts the old value back and refuses the write.
   */
  postSession?(ctx: SessionResultContext): Action | null | Promise<Action | null>
  /**
   * Judge one finished line's output: what `preExecute` saw, plus the exit
   * code, the output and each command's result. A Deny, or an Ask the host
   * has not approved, drops the output (exit 126, a refusal record); a
   * Limit merges with every other opining policy's (tightest per field)
   * and caps it at the workspace boundary.
   */
  postExecute?(ctx: ExecuteResultContext): Action | null | Promise<Action | null>
}
