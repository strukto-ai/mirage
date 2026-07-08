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

import type { CallStack } from '../../shell/call_stack.ts'
import { PathSpec } from '../../types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { classifyParts } from './classify.ts'
import { resolveGlobs } from './globs.ts'
import { type ExecuteFn } from './node.ts'
import { expandParts } from './parts.ts'
import { specWordKinds } from './spec_hints.ts'
import type { TSNodeLike } from './variable.ts'

/**
 * One command's expanded argument vector.
 *
 * `expandArgv` is the only place allowed to know that word zero of an
 * expanded command is its name; every consumer reads named views
 * instead of slicing word lists.
 *
 * `args` and `operands` are two views of the words after the name and
 * may differ in length: a glob expands to many words in `args` but
 * stays one pattern PathSpec in `operands` for mount pushdown.
 */
export class Argv {
  /** Expanded command name. */
  readonly name: string
  /** Text view, shell-level globs resolved (what builtins consume). */
  readonly args: readonly string[]
  /** Classified view, globs left unresolved (mounts, test, ln). */
  readonly operands: readonly (string | PathSpec)[]

  constructor(name: string, args: readonly string[], operands: readonly (string | PathSpec)[]) {
    this.name = name
    this.args = args
    this.operands = operands
    Object.freeze(this)
  }

  /** Full classified word list, name included. */
  get words(): (string | PathSpec)[] {
    if (this.name === '' && this.operands.length === 0) return []
    return [this.name, ...this.operands]
  }

  /** Copy with the classified view replaced (e.g. after symlink rewriting). */
  withOperands(operands: readonly (string | PathSpec)[]): Argv {
    return new Argv(this.name, this.args, [...operands])
  }
}

/**
 * Expand, classify, and glob-resolve a command's word nodes.
 *
 * Uses the cwd mount's CommandSpec (when it has one for the command) to
 * decide which words are TEXT (skip classification) and which are PATH
 * (classify even bare filenames).
 */
export async function expandArgv(
  parts: TSNodeLike[],
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  registry: MountRegistry,
): Promise<Argv> {
  const expanded = await expandParts(parts, session, executeFn, callStack)
  if (expanded.length === 0) return new Argv('', [], [])
  const name = expanded[0] ?? ''

  let textArgs: ReadonlySet<string> | null = null
  let pathArgs: ReadonlySet<string> | null = null
  const cwdMount = registry.mountFor(session.cwd)
  const spec = cwdMount !== null ? cwdMount.specFor(name) : null
  if (spec !== null) {
    const [textSet, pathSet] = specWordKinds(spec, expanded.slice(1))
    textArgs = textSet.size > 0 ? textSet : null
    pathArgs = pathSet.size > 0 ? pathSet : null
  }

  const classified = classifyParts(expanded, registry, session.cwd, textArgs, pathArgs)
  const resolved = await resolveGlobs(classified, registry, textArgs)
  const resolvedText = resolved.map((p) => (p instanceof PathSpec ? p.virtual : p))
  return new Argv(name, resolvedText.slice(1), classified.slice(1))
}
