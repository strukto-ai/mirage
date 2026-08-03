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

import type { Action, CommandContext } from './types.ts'

/**
 * One concern's answers to the workspace lifecycle.
 *
 * Implementations define only the hooks they care about; a hook
 * returns an Action to state an opinion or null to stay silent
 * (directly or as a promise; the seam awaits either), and a hook that
 * throws fails closed (the command is refused, naming the policy).
 * Undefined hooks are detected at the seam and never called.
 *
 * preCommand fires once per classified command (including pipe
 * segments and nested evals), before flag parsing, mount resolution,
 * runtime placement, and backend I/O. Further lifecycle hooks
 * (pre/post execute, pre/post ops) arrive with their seams.
 */
export interface Policy {
  preCommand?(ctx: CommandContext): Action | null | Promise<Action | null>
}
