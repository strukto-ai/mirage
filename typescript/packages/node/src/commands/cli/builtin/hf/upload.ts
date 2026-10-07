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
import { fnmatch } from '@struktoai/mirage-core/utils/fnmatch'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { createRepo } from '../../../../core/hf_hub/admin.ts'
import { repoUrl } from '../../../../core/hf_hub/client.ts'
import { commit, type Addition } from '../../../../core/hf_hub/commit.ts'
import type { HfConfig } from '../../../../core/hf_hub/config.ts'
import { DEFAULT_COMMIT_MESSAGE } from '../../../../core/hf_hub/constants.ts'
import { hubFor, repoTypeOf, requireOperands, requireToken, textOut } from './accessor.ts'
import { refuseVariadic } from './download.ts'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { posixPhrase } from '@struktoai/mirage-core/errors/posix'

interface Row {
  name: string
  data: Uint8Array
}

async function isDir(dispatch: DispatchFn, path: PathSpec): Promise<boolean> {
  const [stat] = await dispatch('stat', path)
  return (stat as { type?: string } | null)?.type === FileType.DIRECTORY
}

/**
 * Read a workspace file, or every file under a workspace directory.
 *
 * Read through the op dispatcher rather than any filesystem of its own: an
 * account CLI has no mount, and the path the line named is an unrelated
 * workspace file, which is exactly what the dispatcher door is for.
 *
 * Reports whether `local` was a directory, because the caller needs it:
 * upstream reads `path_in_repo` as the destination FILE for a file source and
 * as the destination FOLDER for a directory one, so a file uploaded to
 * `u.txt` must land at `u.txt` and not at `u.txt/u.txt`.
 */
async function collect(
  dispatch: DispatchFn,
  local: PathSpec,
): Promise<{ rows: Row[]; fromDir: boolean }> {
  const base = local
  let directory: boolean
  try {
    directory = await isDir(dispatch, base)
  } catch (err) {
    if (isMissingPath(err) || isEnotdir(err)) {
      throw new UsageError(`${local.rawPath}: ${fsStrerror(err) ?? posixPhrase('ENOENT')}`)
    }
    throw err
  }
  if (!directory) {
    const [data] = await dispatch('read', base)
    return {
      rows: [
        { name: base.virtual.slice(base.virtual.lastIndexOf('/') + 1), data: data as Uint8Array },
      ],
      fromDir: false,
    }
  }
  const rows: Row[] = []
  const pending = [base]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    const [entries] = await dispatch('readdir', current)
    for (const entry of entries as string[]) {
      const child = current.join(entry)
      if (await isDir(dispatch, child)) {
        pending.push(child)
        continue
      }
      const [data] = await dispatch('read', child)
      rows.push({
        name: child.virtual.slice(base.virtual.replace(/\/$/, '').length + 1),
        data: data as Uint8Array,
      })
    }
  }
  return {
    rows: rows.sort((a, b) => compareCodePoints(a.name, b.name)),
    fromDir: true,
  }
}

/** Apply the line's --include and --exclude globs. */
export function keep(rows: Row[], include: readonly string[], exclude: readonly string[]): Row[] {
  let out = rows
  if (include.length > 0) {
    out = out.filter((row) => include.some((pattern) => fnmatch(row.name, pattern)))
  }
  if (exclude.length > 0) {
    out = out.filter((row) => !exclude.some((pattern) => fnmatch(row.name, pattern)))
  }
  return out
}

/**
 * The repo-relative directory an upload's third operand names.
 *
 * A Hub path is repo-relative with no leading slash and no `.` component, so
 * the operand is normalized rather than used verbatim: `hf upload repo /local .`
 * means the repository root, and taking the dot literally stored every file
 * under `./`, which is a path the resolve endpoint then could not find.
 */
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
  const operands = inv.texts.slice(1)
  const include = fl.asList('include')
  const exclude = fl.asList('exclude')
  const deletions = fl.asList('delete')
  for (const [patterns, flag] of [
    [include, '--include'],
    [exclude, '--exclude'],
    [deletions, '--delete'],
  ] as [readonly string[], string][]) {
    if (patterns.length > 0) refuseVariadic(operands, flag, patterns)
  }
  const local = operands[0] ?? '.'
  const inRepo = operands[1] ?? ''
  const collected = await collect(
    dispatch,
    PathSpec.fromStrPath(local, undefined, inv.env.PWD ?? '/'),
  )
  const rows = keep(collected.rows, include, exclude)
  if (rows.length === 0) throw new UsageError(`no files matched under ${local}`)
  const base = inRepoBase(inRepo)
  // A directory source spreads under `path_in_repo`; a file source lands AT
  // it. Appending the basename either way stored `hf upload r f.txt f.txt` at
  // `f.txt/f.txt`, which the tree then reported as a directory and
  // `hf download` could not find at all.
  const additions: Addition[] = collected.fromDir
    ? rows.map((row) => ({ path: base === '' ? row.name : `${base}/${row.name}`, data: row.data }))
    : [
        {
          path: base === '' ? (rows[0]?.name ?? '') : base,
          data: rows[0]?.data ?? new Uint8Array(),
        },
      ]
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
  await commit(accessor, {
    additions,
    deletions: [...deletions],
    message: fl.asStr('commit_message') ?? DEFAULT_COMMIT_MESSAGE,
    description: fl.asStr('commit_description') ?? '',
    createPr: fl.asBool('create_pr'),
  })
  const home = repoUrl((inv.config as HfConfig).endpoint, accessor.repoType, repoId)
  const url = rstripSlash(`${home}/tree/${accessor.revision}/${base}`)
  return textOut(`${url}\n`)
}
