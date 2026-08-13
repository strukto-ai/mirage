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
   * Admit or refuse one VFS op, whatever door it entered. The hot
   * path: fires per op, so keep the hook cheap; expensive decisions
   * belong at preCommand or precomputed into policy state.
   */
  preOps?(ctx: OpsContext): Action | null | Promise<Action | null>
  /** Observe one completed VFS op; a Deny suppresses its result, a
   * Limit caps a byte-producing one. */
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
