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

import type { CLIInvocation } from '@struktoai/mirage-core/commands/cli/types'
import type { CommandFnResult } from '@struktoai/mirage-core/commands/config'
import { UsageError } from '@struktoai/mirage-core/commands/errors'
import { FlagView } from '@struktoai/mirage-core/commands/spec/index'
import type { DispatchFn } from '@struktoai/mirage-core/runtime/types'
import { FileType, PathSpec } from '@struktoai/mirage-core/types'
import { fsStrerror, isEnotdir, isMissingPath } from '@struktoai/mirage-core/errors/fs'
import { shellQuote } from '@struktoai/mirage-core/utils/quote'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { createRepo } from '../../../../core/hf_hub/admin.ts'
import { repoUrl } from '../../../../core/hf_hub/client.ts'
import { commit, type Addition } from '../../../../core/hf_hub/commit.ts'
import type { HfConfig } from '../../../../core/hf_hub/config.ts'
import {
  DEFAULT_COMMIT_MESSAGE,
  DEFAULT_IGNORE_PATTERNS,
  EMPTY_COMMIT_WARNING,
} from '../../../../core/hf_hub/constants.ts'
import {
  deletionsFor,
  fetchTree,
  filterRepoPaths,
  repoFiles,
} from '../../../../core/hf_hub/tree.ts'
import { hubFor, repoTypeOf, requireOperands, requireToken, textOut } from './accessor.ts'
import { refuseVariadic } from './download.ts'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { posixPhrase } from '@struktoai/mirage-core/errors/posix'

async function isDir(dispatch: DispatchFn, path: PathSpec): Promise<boolean> {
  const [stat] = await dispatch('stat', path)
  return (stat as { type?: string } | null)?.type === FileType.DIRECTORY
}

/**
 * Read workspace files as additions relative to the source.
 * Walk one level at a time so symlink targets outside `local` retain the
 * names reached through the source directory. Report whether the source
 * was a directory, which determines the destination semantics.
 */
async function collect(
  dispatch: DispatchFn,
  local: PathSpec,
): Promise<{ rows: Addition[]; fromDir: boolean }> {
  if (!(await isDir(dispatch, local))) {
    const [data] = await dispatch('read', local)
    const name = rstripSlash(local.virtual)
    return {
      rows: [{ path: name.slice(name.lastIndexOf('/') + 1), data: data as Uint8Array }],
      fromDir: false,
    }
  }
  const rows: Addition[] = []
  const pending: [PathSpec, string][] = [[local, '']]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [current, prefix] = next
    const [entries] = await dispatch('readdir', current)
    for (const entry of entries as string[]) {
      const child = current.join(entry)
      const leaf = rstripSlash(child.virtual)
      const name = `${prefix}${leaf.slice(leaf.lastIndexOf('/') + 1)}`
      if (await isDir(dispatch, child)) {
        pending.push([child, `${name}/`])
        continue
      }
      const [data] = await dispatch('read', child)
      rows.push({ path: name, data: data as Uint8Array })
    }
  }
  return {
    rows: rows.sort((a, b) => compareCodePoints(a.path, b.path)),
    fromDir: true,
  }
}

/** Apply the line's --include and --exclude globs. */
export function keep(
  rows: Addition[],
  include: readonly string[],
  exclude: readonly string[],
): Addition[] {
  const kept = new Set(
    filterRepoPaths(
      rows.map((row) => row.path),
      include,
      exclude,
    ),
  )
  return rows.filter((row) => kept.has(row.path))
}

/** Normalize an upload destination; `.` means the repository root. */
export function inRepoBase(value: string): string {
  const cleaned = value.trim()
  if (cleaned === '') return ''
  const parts: string[] = []
  for (const part of cleaned.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.pop() === undefined) {
        throw new UsageError(`path_in_repo must stay inside the repository: ${value}`)
      }
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

/** Upload a workspace file or folder to a repository, as one commit. */
export async function uploadCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  requireOperands(inv, ['repo_id'])
  requireToken(inv, 'upload')
  const fl = new FlagView(inv.flags)
  const dispatch = inv.doors?.dispatch
  if (dispatch === undefined) {
    throw new UsageError('hf upload needs a workspace to read from')
  }
  const repoId = inv.texts[0] ?? ''
  // LOCAL_PATH is path-typed, so the parser resolved it against the cwd;
  // without one, upstream's `_resolve_upload_paths` reads the file or folder
  // named after the repository (`hf upload acme/model` reads `./model`) and
  // refuses when there is none.
  const source =
    inv.paths[0] ??
    PathSpec.fromStrPath(repoId.slice(repoId.lastIndexOf('/') + 1), undefined, inv.cwd)
  const operands = [...inv.paths.map((path) => path.rawPath), ...inv.texts.slice(1)]
  const include = fl.asList('include')
  const exclude = fl.asList('exclude')
  const deletions = fl.asList('delete')
  const patternFlags: [string, readonly string[]][] = [
    ['--include', include],
    ['--exclude', exclude],
    ['--delete', deletions],
  ]
  for (const [flag, patterns] of patternFlags) {
    if (patterns.length > 0) refuseVariadic(operands, flag, patterns)
  }
  const inRepo = inv.texts[1] ?? ''
  let collected: { rows: Addition[]; fromDir: boolean }
  try {
    collected = await collect(dispatch, source)
  } catch (err) {
    if (!isMissingPath(err) && !isEnotdir(err)) throw err
    throw new UsageError(
      inv.paths.length > 0
        ? `${shellQuote(source.rawPath)}: ${fsStrerror(err) ?? posixPhrase('ENOENT')}`
        : `'${source.rawPath}' is not a local file or folder. Please set local_path explicitly.`,
    )
  }
  const base = inRepoBase(inRepo)
  let warnings = ''
  // Folder contents spread under path_in_repo; a single file lands at it.
  // Upstream applies filters only to folders and warns for single files.
  let additions: Addition[]
  if (collected.fromDir) {
    additions = keep(collected.rows, include, [...exclude, ...DEFAULT_IGNORE_PATTERNS]).map(
      (row) => ({ path: base === '' ? row.path : `${base}/${row.path}`, data: row.data }),
    )
  } else {
    for (const [flag, patterns] of patternFlags) {
      if (patterns.length > 0) warnings += `Ignoring ${flag} since a single file is uploaded.\n`
    }
    additions = collected.rows.map(({ path, data }) => ({ path: base || path, data }))
  }
  const repoType = repoTypeOf(fl)
  // Upstream creates the repository if it is missing and ignores --private
  // when it already exists, so the flag picks the visibility of one this line
  // brings into being rather than changing an existing repository's.
  await createRepo(inv.config as HfConfig, repoId, {
    repoType,
    private: fl.asBool('private'),
    existOk: true,
  })
  const accessor = hubFor(inv, repoId, repoType, fl.asStr('revision'))
  // For a folder the --delete patterns match the repo's files under
  // `path_in_repo`, and a file this commit re-adds is not deleted first. A
  // commit that would change nothing is skipped, with upstream's create_commit
  // warning.
  const added = new Set(additions.map((add) => add.path))
  const doomed =
    collected.fromDir && deletions.length > 0
      ? deletionsFor(repoFiles(await fetchTree(accessor)), deletions, base).filter(
          (path) => !added.has(path),
        )
      : []
  const message = fl.asStr('commit_message')
  const reply = await commit(accessor, {
    additions,
    deletions: doomed,
    message: message === undefined || message === '' ? DEFAULT_COMMIT_MESSAGE : message,
    description: fl.asStr('commit_description') ?? '',
    createPr: fl.asBool('create_pr'),
  })
  if (reply === undefined) warnings += EMPTY_COMMIT_WARNING
  const home = repoUrl((inv.config as HfConfig).endpoint, accessor.repoType, repoId)
  const url = rstripSlash(`${home}/tree/${accessor.revision}/${base}`)
  return textOut(`${url}\n`, warnings)
}
