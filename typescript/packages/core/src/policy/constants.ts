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

import type { ScriptMethod } from './types.ts'

/**
 * The reason a bare command pattern under `commands.deny` carries, and
 * the one a bare pattern under `commands.ask` carries.
 */
export const DEFAULT_DENY_REASON = 'denied by policy'
export const DEFAULT_ASK_REASON = 'no standing approval'

/**
 * Ops that act on a whole subtree at once, so a pure path rule refuses
 * them on the directory that holds its scope or on any ancestor: moving
 * or removing `/x` takes `/x/locked/*` along. `rmdir` removes the scope's
 * own directory; `rm_r` removes a tree in one call. They are pinned to what
 * the functions declare by constants.test.ts: policy sits below vfs (the Pyodide
 * worker loads it), so it cannot read the declarations itself.
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
 * deny rule lets through at the dispatcher: deny means present and refused,
 * not absent, so a listing shows the entry's name and size and the read
 * of it is what fails, as GNU reports an unreadable file. The command
 * tier's guard leaves its `stat` slot unwrapped for the same reason; a
 * hidden path is the hide arm's, and stays ENOENT. `exists` is the command
 * tier's probe; `stat` is pinned like SUBTREE_OPS's VFS ops.
 */
export const METADATA_OPS: ReadonlySet<string> = new Set(['stat', 'exists'])

/**
 * The methods a profile's policy names programs for, the pre_ four
 * answered before the action runs and the post_ four after it: the Policy
 * interface's spelling to the document's.
 */
export const METHODS = {
  preExecute: 'pre_execute',
  preCommand: 'pre_command',
  preVfs: 'pre_vfs',
  preSession: 'pre_session',
  postExecute: 'post_execute',
  postCommand: 'post_command',
  postVfs: 'post_vfs',
  postSession: 'post_session',
} as const satisfies Record<ScriptMethod, string>

/** The runtimes a policy program runs on: monty, and Python on wasm. */
export const PROGRAM_RUNTIMES: ReadonlySet<string> = new Set(['monty', 'pyodide'])

/** The runtime a policy program runs on when it names none. */
export const PROGRAM_RUNTIME = 'monty'

/**
 * The interpreter switches a program runs with, per runtime: `-P` keeps
 * the session's directory off `sys.path`, so no file there stands in for
 * a module the program imports. Monty has no `sys.path`.
 */
export const PROGRAM_FLAGS: ReadonlyMap<string, Readonly<Record<string, boolean>>> = new Map([
  ['pyodide', { P: true }],
])

/**
 * The memory a policy program gets when its runtime's config names none:
 * monty's own example cap, and enough for Python on wasm, whose worker
 * starts at about 50M. `maxMemory: null` in the config lifts it.
 */
export const PROGRAM_MEMORY: ReadonlyMap<string, string> = new Map([
  ['monty', '10M'],
  ['pyodide', '128M'],
])

/**
 * The environment variable a policy program reads its context from, as
 * JSON; the same text arrives on stdin.
 */
export const CTX_ENV = 'MIRAGE_POLICY_CTX'
