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

import type {
  Action,
  CommandContext,
  ExecuteResultContext,
  OpsContext,
  OpsResultContext,
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
   * Admit or refuse one VFS op, at the op doors and on the command
   * tier's backend I/O. The doors are the dispatcher and the ops
   * facade (`ws.vfs`), which is also how FUSE, the runtime guests,
   * `find -delete` and the warm cache arrive; a mount command's
   * handler (cat, grep -r, sed -i, rm) admits each content read,
   * mutation and readdir through the same hook (`withPolicyGuard`),
   * before its own warm cache. On that tier the op is named by
   * adapter slot in its shared snake spelling (read_bytes,
   * read_stream, rm_r, ...), so a policy portable across the tiers
   * keys on `write` and `path`; stat/exists and native find/du
   * enumeration stay unguarded as presence facts (mode-000 shape: a
   * denied entry lists and stats, the read of it fails), and a native
   * subtree op (rm_r, dir_copy) admits as the one op the backend
   * performs. The hot path: fires per op (thousands under one
   * recursive command), so keep the hook cheap; expensive decisions
   * belong at preCommand or precomputed into policy state.
   */
  preOps?(ctx: OpsContext): Action | null | Promise<Action | null>
  /** Observe one completed VFS op; a Deny suppresses its result, a
   * Limit caps a byte-producing one. Narrower than preOps: the
   * dispatcher and facade doors only. The backend I/O inside a mount
   * command's handler and each `find -delete` deletion admit through
   * preOps and report no per-op result here; the command tier's
   * result plane is postExecute, which bounds the finished line's
   * output. */
  postOps?(ctx: OpsResultContext): Action | null | Promise<Action | null>
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
