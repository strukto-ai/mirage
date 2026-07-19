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

import type { BoxAccessor } from '../../../accessor/box.ts'
import { stream as boxStream } from '../../../core/box/read.ts'
import { readdir as boxReaddir } from '../../../core/box/readdir.ts'
import { stat as boxStat } from '../../../core/box/stat.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { defaultProvision } from '../generic_bind/provision.ts'
import { patternArg } from '../grep_helper.ts'
import { rgGeneric } from '../generic/rg.ts'
import { BOX_IO } from './io.ts'
import { narrowScope } from './narrow.ts'

const boxResolveGlob = resolveGlobOf(BOX_IO)

// Reproduce rg's dotfile pruning for search-narrowed candidates: the generic
// rg walk skips hidden files and never descends into hidden directories, but
// explicit file operands bypass that pruning, so narrowed candidates are
// filtered on every path segment below their (longest-matching) scope.
export function keepVisible(
  narrowed: PathSpec[],
  scopes: readonly PathSpec[],
  hidden: boolean,
): PathSpec[] {
  if (hidden) return narrowed
  const kept: PathSpec[] = []
  for (const p of narrowed) {
    let rel = p.virtual
    let best = -1
    for (const scope of scopes) {
      const base = scope.virtual.replace(/\/+$/, '')
      if (base.length > best && (p.virtual === base || p.virtual.startsWith(base + '/'))) {
        rel = p.virtual.slice(base.length)
        best = base.length
      }
    }
    const segments = rel.split('/').filter((s) => s !== '')
    if (segments.some((s) => s.startsWith('.'))) continue
    kept.push(p)
  }
  return kept
}

async function rgCommand(
  accessor: BoxAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  let resolved = paths
  let runOpts = opts
  if (paths.length > 0) {
    const pattern = patternArg(texts, opts.flags)
    // -v needs the walk (a narrowed superset hides fully non-matching files
    // whose every line matches inverted); --type/--glob keep the walk so
    // their file filtering stays in one place.
    const narrowed = await narrowScope(accessor, paths, pattern, {
      fixedString: opts.flags.F === true,
      recursive: true,
      exactFileSet:
        opts.flags.v === true ||
        typeof opts.flags.type === 'string' ||
        typeof opts.flags.glob === 'string',
      ...(opts.index !== null ? { index: opts.index } : {}),
    })
    if (narrowed.usedSearch) {
      const visible = keepVisible(narrowed.resolved, paths, opts.flags.hidden === true)
      if (visible.length === 0) return [new Uint8Array(), new IOResult({ exitCode: 1 })]
      resolved = visible
      // ripgrep labels every file a walk finds; narrowed candidates arrive as
      // explicit operands, so force the label flag — unless -I suppresses
      // labels (forcing H would defeat it in the delegated grepGeneric body).
      if (opts.flags.args_I !== true) {
        runOpts = { ...opts, flags: { ...opts.flags, H: true } }
      }
    } else {
      resolved = narrowed.resolved
    }
  }
  const stat = (p: PathSpec): Promise<FileStat> => boxStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    boxReaddir(accessor, p, opts.index ?? undefined)
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> =>
    boxStream(accessor, p, opts.index ?? undefined)
  return rgGeneric(resolved, texts, runOpts, stat, readdir, stream)
}

export const BOX_RG = command({
  name: 'rg',
  resource: ResourceName.BOX,
  spec: specOf('rg'),
  fn: rgCommand,
  // Same cost estimate the generic-bound rg carried; narrowing only ever
  // lowers the real cost below it.
  provision: defaultProvision('rg', BOX_IO.stat, boxResolveGlob, BOX_IO.readdir),
})
