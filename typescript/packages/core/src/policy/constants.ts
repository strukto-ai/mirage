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

import { Outcome } from './types.ts'

/**
 * A whole-command refusal exits as bash does for a command it found but
 * may not run.
 */
export const POLICY_DENIED_EXIT = 126

/**
 * Which verb wins when two rules speak about the same subject at the
 * same anchor depth: deny before ask. Both gates order by it, which is
 * what keeps the entry gate from contradicting the admission gate.
 */
export const DENY_FIRST = 0
export const ASK_SECOND = 1

/**
 * The same ordering as the outcome a rule produces, for the gate that
 * has already named the verb. ALLOW is absent because only a rule ties
 * against a rule, and nothing in the document says allow at a path.
 */
export const VERB_ORDER: Readonly<Record<string, number>> = {
  [Outcome.DENY]: DENY_FIRST,
  [Outcome.ASK]: ASK_SECOND,
}

/**
 * The reason a bare command pattern under `commands.deny` carries, and
 * the one a bare pattern under `commands.ask` carries.
 */
export const DEFAULT_DENY_REASON = 'denied by policy'
export const DEFAULT_ASK_REASON = 'no standing approval'

/**
 * The one pattern token that matches any one line token; trailing, it
 * matches whatever follows, which a prefix already does.
 */
export const WILDCARD = '*'

/**
 * Ops that act on a whole subtree at once, so a pure path rule refuses
 * them on the directory that holds its scope or on any ancestor: moving
 * or removing `/x` takes `/x/locked/*` along. `rename` is the
 * dispatcher's; `rmdir` removes the scope's own directory; `rm_r` is the
 * command tier's recursive remove.
 */
export const SUBTREE_OPS: ReadonlySet<string> = new Set(['rename', 'rmdir', 'rm_r'])

/**
 * Commands whose operand is a whole subtree they move or remove, so a
 * path rule judges the operand the way it judges a SUBTREE_OPS op: the
 * directory holding the scope, or any ancestor of it, is the scope. Only
 * the destroyers: a reader given an ancestor (`grep -r`, `du`, `tar`) is
 * the command tier's I/O to refuse file by file, not a line to refuse
 * whole.
 */
export const SUBTREE_COMMANDS: ReadonlySet<string> = new Set(['rm', 'rmdir', 'mv'])

/**
 * Ops that read an entry's metadata and nothing of its content, which a
 * deny rule lets through at the op door: deny means present and refused,
 * not absent, so a listing shows the entry's name and size and the read
 * of it is what fails, as GNU reports an unreadable file. The command
 * tier's guard leaves its `stat` slot unwrapped for the same reason; a
 * hidden path is the hide arm's, and stays ENOENT.
 */
export const METADATA_OPS: ReadonlySet<string> = new Set(['stat', 'exists'])
