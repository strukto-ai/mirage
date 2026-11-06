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

import type { FsCondition } from '../errors/index.ts'

/** Capture unresolved program names without taking over the workspace shell. */
export const EXTERNAL_COMMANDS = '@external'

/** Capture the whole line, Mirage's own commands included (a line executor). Mirrors Python's WHOLE_LINE. */
export const WHOLE_LINE = '@line'

/** The interpreter names Mirage owns for python: the class-default captures of every python engine. */
export const PYTHON_COMMANDS: readonly string[] = ['python3', 'python']

/** The interpreter names Mirage owns for js: the class-default captures of every js engine. */
export const JS_COMMANDS: readonly string[] = ['node', 'js']

/** The names a language runtime may capture, by language. */
export const LANGUAGE_COMMANDS: Readonly<Record<'python' | 'js', readonly string[]>> = {
  python: PYTHON_COMMANDS,
  js: JS_COMMANDS,
}

/**
 * Capture both names of a tier at once. A group names interpreters only: a
 * tool such as pip or npx reaches a sandbox through `EXTERNAL_COMMANDS`.
 */
export const PYTHON_GROUP = '@python'

/** Capture `node` and `js`; see `PYTHON_GROUP`. */
export const JS_GROUP = '@js'

const CAPTURE_GROUPS: ReadonlyMap<string, readonly string[]> = new Map([
  [PYTHON_GROUP, PYTHON_COMMANDS],
  [JS_GROUP, JS_COMMANDS],
])

/** A runtime's captures with each group spelled as its names. */
export function expandCaptures(captures: readonly string[]): string[] {
  return [...new Set(captures.flatMap((capture) => CAPTURE_GROUPS.get(capture) ?? [capture]))]
}

/**
 * The most requests one runtime file adapter keeps in flight.
 *
 * Classifying or preloading an entry is a request of its own on a
 * mount that keeps no listing index, so an unbounded listing puts a
 * whole directory's worth of requests on the wire together. Every
 * request an entry point sends shares the one cap, a preload walk's included.
 */
export const LISTING_ENTRY_CONCURRENCY = 16

/**
 * What a stat or a listing may answer "not there" with. A directory is
 * an answer to both rather than an absence, and a backend that refused
 * the op has not said the path is gone: folding a permission or a
 * transport failure into "no" reports it as an absence the guest cannot
 * tell from a real one, so nothing else belongs here.
 */
export const ABSENT_PATH: ReadonlySet<FsCondition> = new Set<FsCondition>(['ENOENT', 'ENOTDIR'])

/**
 * What a hard link is refused with, wherever one can be spelled (node's
 * patched `fs.link`): a hard link is a second name for one inode, and
 * nothing above a mount holds that.
 */
export const HARD_LINK_REFUSAL: FsCondition = 'EPERM'

/**
 * How long one policy program (a profile's `policy:` or the `routePolicy`)
 * may run before the action it judges is refused or the route it decides
 * fails. One bound for every stage; a holder object so tests can tighten
 * it.
 */
export const SCRIPT_EVAL_TIMEOUT = { seconds: 10 }

/**
 * The config fields that hold a runtime's credential, as a config writes
 * them: a saved runtime keeps them sealed, as a mount keeps a secret field.
 */
export const SECRET_CONFIG_FIELDS: ReadonlySet<string> = new Set(['api_key', 'private_key'])
