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

import type { Accessor } from '../../../accessor/base.ts'
import { pathsScoped } from '../../../ops/namespace_view.ts'
import { makeSearchBackedFind } from '../../../core/generic/find.ts'
import type { SlugTree } from '../../../core/slug_tree/tree.ts'
import { materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { StatOp } from '../../../vfs/types.ts'
import { type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { treeHasMtime } from '../find_eval.ts'
import { parseFindExpression, type FindExpr } from '../find_parse.ts'
import { findGeneric } from '../generic/find.ts'
import {
  resolveGlobOf,
  guardOperation,
  type Builder,
  type CommandIO,
} from '../generic_bind/adapter.ts'
import { findWalk } from '../generic_bind/builders/find.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function isBareName(texts: readonly string[]): boolean {
  const first = texts[0]
  return first !== undefined && !first.startsWith('-') && !['(', ')', '!'].includes(first)
}

function defaultName(name: string | undefined, texts: readonly string[]): string | undefined {
  if (name !== undefined) return name
  return isBareName(texts) ? texts[0] : undefined
}

async function normalizeFindOutput(
  stdout: ByteSource | null,
  searchPath: PathSpec,
): Promise<ByteSource | null> {
  if (stdout === null) return null
  const data = await materialize(stdout)
  const prefix = rstripSlash(mountPrefixOf(searchPath.virtual, searchPath.vfsPath))
  const root = prefix !== '' ? prefix : '/'
  const text = DEC.decode(data)
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const normalized = lines.map((line) => (line === root + '/' ? root : line))
  if (normalized.length === 0) return new Uint8Array(0)
  return ENC.encode(normalized.join('\n') + '\n')
}

/** Whether the expression tests a timestamp. `-printf` and `-ls` are not tests: they stat through the dispatcher. */
export function readsTimes(expr: FindExpr): boolean {
  return expr.newer.length > 0 || treeHasMtime(expr.tree)
}

/** Whether the expression tests a file size (`-empty` compares one with zero). */
export function readsSizes(expr: FindExpr): boolean {
  return expr.minSize !== null || expr.maxSize !== null || expr.usesEmpty
}

/** Whether the flag bag carries a size or time test. Only a direct call hands tests over as flags; the shell passes them as words. */
function flagsTest(fl: FlagView): boolean {
  return fl.asStr('size') !== undefined || fl.asStr('mtime') !== undefined || fl.asBool('empty')
}

/** Build a find override using the factory's prepared operations.
 * `tree` supplies unrestricted native traversal, `statLight` cheaper metadata,
 * and `needsFull` selects expressions needing the full stat. */
export function makeFind<A extends Accessor>(
  tree: SlugTree<A>,
  statLight: StatOp<A>,
  needsFull: (expr: FindExpr) => boolean,
): Builder<A> {
  return {
    name: 'find',
    fn: async (
      ops: CommandIO<A>,
      accessor: A,
      paths: PathSpec[],
      texts: string[],
      opts: CommandOpts,
    ): Promise<CommandFnResult> => {
      const light = guardOperation(statLight, 'stat')
      const resolveGlob = resolveGlobOf(ops)
      const index = opts.index ?? undefined
      const resolved = await resolveGlob(
        accessor,
        paths.length > 0 ? paths : [PathSpec.fromStrPath(opts.cwd)],
        index,
      )
      const searchPath = resolved[0]
      // Push-down choices: a bare word acts as the -name filter, and the
      // heavier stat is only paid when a test needs what it adds.
      const fl = new FlagView(opts.flags, specOf('find'))
      const bag: Record<string, FlagValue> = { ...opts.flags }
      const name = defaultName(fl.asStr('name'), texts)
      if (name !== undefined) bag.name = name
      const words = isBareName(texts) ? [] : texts
      const full = words.length > 0 ? needsFull(parseFindExpression(words)) : flagsTest(fl)
      const statFn = full ? ops.stat : light
      const findCore = makeSearchBackedFind<A>({
        resolvePath: tree.resolve,
        stat: statFn,
        walk: tree.walk,
      })
      // A tree walk classifies on the raw backend tree, so under hidden
      // paths or a path rule it would answer for entries the session cannot
      // see; the walk classifies through the guarded readdir/stat, the fork
      // the factory builder takes.
      const result = pathsScoped(opts.ns, resolved)
        ? await findWalk(full ? ops : { ...ops, stat: light }, accessor, resolved, words, {
            ...opts,
            flags: bag,
          })
        : await findGeneric(
            resolved,
            words,
            { ...opts, flags: bag },
            (root, options) => findCore(accessor, root, options, index),
            (spec: PathSpec) => statFn(accessor, spec, index),
          )
      if (result === null || searchPath === undefined) return result
      const [stdout, ioResult] = result
      return [await normalizeFindOutput(stdout, searchPath), ioResult]
    },
  }
}
