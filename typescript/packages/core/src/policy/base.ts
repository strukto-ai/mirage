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

import type { RouteContext } from '../runtime/routing/types.ts'
import type {
  Action,
  CommandContext,
  ExecuteResultContext,
  VfsContext,
  VfsResultContext,
  SessionContext,
} from './types.ts'

/**
 * One concern's answers to the workspace lifecycle.
 *
 * Implementations define only the hooks they care about; a hook
 * returns an Action to state an opinion or null to stay silent
 * (directly or as a promise; the seam awaits either), and a hook that
 * throws fails closed (the command is refused, naming the policy).
 * Undefined hooks are detected at the seam and never called.
 */
export interface Policy {
  preCommand?(ctx: CommandContext): Action | null | Promise<Action | null>
  /**
   * Place or refuse one typed line before any of it runs. Fires once per
   * line, after the line clears admission (a line a rule refuses is never
   * placed) and before it runs, with the payload a `routePolicy` reads; a
   * nested line keeps the placement of the line that ran it. A Route
   * names the runtime that serves the line, and a Deny refuses it whole,
   * exit 126 and `<command>: Permission denied`. The workspace's
   * `routePolicy` answers here as a built-in, ahead of the policies
   * registered in code.
   */
  preExecute?(ctx: RouteContext): Action | null | Promise<Action | null>
  /**
   * Admit or refuse one VFS op, at the dispatcher and on the command
   * tier's backend I/O. The entry points are the dispatcher and `ws.vfs`,
   * which is also how FUSE, the runtime guests, `find -delete`, the warm
   * cache and a mount command's content reads and mutations arrive; the
   * command's readdir admits through the same hook (`withCommandGuards`).
   * stat/exists stay unguarded as presence facts (mode-000 shape: a
   * denied entry lists and stats, the read of it fails). While a coded
   * policy is installed the dispatcher declines a one-call tree op
   * (rm_r, copy, dir_copy, find, du, search), so the command walks and
   * each entry's op is admitted on its own. The hot path: fires per op (thousands under one
   * recursive command), so keep the hook cheap; expensive decisions
   * belong at preCommand or precomputed into policy state.
   */
  preVfs?(ctx: VfsContext): Action | null | Promise<Action | null>
  /** Observe one completed VFS op; a Deny suppresses its result, a
   * Limit caps a byte-producing one. Narrower than preVfs: the
   * dispatcher and facade entry points only. The backend I/O inside a mount
   * command's handler and each `find -delete` deletion admit through
   * preVfs and report no per-op result here; the command tier's
   * result plane is postExecute, which bounds the finished line's
   * output. */
  postVfs?(ctx: VfsResultContext): Action | null | Promise<Action | null>
  /**
   * Bound one finished execute() line's output. A Limit returned here
   * merges with every other opining policy's (tightest per field) and
   * caps the line's stdout at the workspace boundary.
   */
  postExecute?(ctx: ExecuteResultContext): Action | null | Promise<Action | null>
  /**
   * Admit or refuse one session-state mutation (an env set/unset) on
   * the session plane, before the write lands.
   */
  preSession?(ctx: SessionContext): Action | null | Promise<Action | null>
}
