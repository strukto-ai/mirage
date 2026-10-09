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

import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  AmbiguousArgumentError,
  EmptyPathspecError,
  GitError,
  InvalidRevisionNameError,
  UsageError,
} from './errors.ts'
import { readIndex } from './index_file.ts'
import { visiblePath, pathspecPatterns, pathspecSelects, repoRelative } from './pathspec.ts'
import { quotePath, relativePath } from './render.ts'
import { configBool } from './repo.ts'
import { opened } from './session.ts'
import { listedTree, resolveTree } from './tree.ts'
import { checkSwitches, fatal, startPoint, verbUsage } from './util.ts'

/**
 * List index paths, including conflict stages when requested.
 *
 * Without a pathspec the listing is the start directory's subtree; with one
 * it is whatever the pathspec names, anywhere in the tree, spelled relative to
 * the start directory (`ls-files ..` from a subdirectory prints
 * `../README.md`).
 */
export async function lsFiles(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    checkSwitches(inv, inv.texts)
    const repo = await opened(fl, inv.view ?? {})
    const fully = await configBool(repo, 'core.quotepath', true)
    const state = await readIndex(repo, repo.dispatch)
    const start = startPoint(fl).virtual
    const prefix = repoRelative(repo.location, start, '.')
    const patterns = pathspecPatterns(repo.location, start, inv.texts)
    const rows = [...state.entries.values()]
    for (const conflict of state.conflicts.values()) {
      for (const entry of [conflict.ancestor, conflict.this, conflict.other])
        if (entry) rows.push(entry)
    }
    rows.sort((a, b) => compareCodePoints(a.path, b.path) || a.stage - b.stage)
    const nul = fl.asBool('z')
    let out = ''
    for (const entry of rows) {
      if (
        !visiblePath(repo.location, entry.path) ||
        !pathspecSelects(entry.path, patterns.length ? patterns : [prefix])
      )
        continue
      const relative = relativePath(entry.path, prefix)
      const label = nul ? relative : quotePath(relative, false, fully)
      const metadata = fl.asBool('stage')
        ? `${entry.mode.toString(8).padStart(6, '0')} ${entry.oid} ${String(entry.stage)}\t`
        : ''
      out += metadata + label + (nul ? '\0' : '\n')
    }
    return [encodeText(out), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

/** List tree metadata without reading file contents. */
export async function lsTree(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    checkSwitches(inv, inv.texts)
    const [name, ...paths] = inv.texts
    if (name === undefined) throw new UsageError('', verbUsage(inv))
    const repo = await opened(fl, inv.view ?? {})
    let tree: string
    try {
      tree = await resolveTree(repo, name)
    } catch (err) {
      if (err instanceof AmbiguousArgumentError || err instanceof InvalidRevisionNameError)
        throw new GitError(`Not a valid object name ${name}`)
      throw err
    }
    const fullTree = fl.asBool('full_tree')
    const start = fullTree ? repo.location.worktree.virtual : startPoint(fl).virtual
    const prefix = repoRelative(repo.location, start, '.')
    let patterns = paths.map((path) => {
      if (path === '') throw new EmptyPathspecError()
      const relative = repoRelative(repo.location, start, path)
      const directory = /(?:^|\/)(?:\.\.?|)$/.test(path)
      return relative + (relative && directory ? '/' : '')
    })
    if (!patterns.length && prefix) patterns = [prefix + '/']
    const rows = await listedTree(
      repo,
      tree,
      patterns,
      fl.asBool('r'),
      fl.asBool('t'),
      fl.asBool('d'),
    )
    const fully = await configBool(repo, 'core.quotepath', true)
    const nul = fl.asBool('z')
    const names = fl.asBool('name_only') || fl.asBool('name_status')
    const fullName = fullTree || fl.asBool('full_name')
    const terminator = nul ? '\0' : '\n'
    const out: string[] = []
    for (const [path, mode, oid] of rows) {
      if (!visiblePath(repo.location, path)) continue
      const relative = fullName ? path : relativePath(path, prefix)
      const label = nul ? relative : quotePath(relative, false, fully)
      const kind = mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob'
      out.push((names ? '' : `${mode} ${kind} ${oid}\t`) + label + terminator)
    }
    return [encodeText(out.join('')), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
