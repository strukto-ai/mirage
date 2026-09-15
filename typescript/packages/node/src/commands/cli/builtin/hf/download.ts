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
import { PathSpec } from '@struktoai/mirage-core/types'
import { isMissingPath } from '@struktoai/mirage-core/utils/errors'
import { fnmatch } from '@struktoai/mirage-core/utils/fnmatch'
import { parent } from '@struktoai/mirage-core/utils/path'
import type { HfHubAccessor } from '../../../../accessor/hf_hub.ts'
import {
  blobPath,
  cacheRoot,
  etagOf,
  linkTarget,
  refPath,
  repoFolderName,
  snapshotDir,
  snapshotPath,
} from '../../../../core/hf_hub/cache.ts'
import { HfHubError, hubBytes, resolveUrl } from '../../../../core/hf_hub/client.ts'
import { Absence, classifyAbsence, headCommit, revisionUrl } from '../../../../core/hf_hub/repo.ts'
import { GLOB_CHARS, MAX_DOWNLOAD_WORKERS } from '../../../../core/hf_hub/constants.ts'
import { fetchTree } from '../../../../core/hf_hub/tree.ts'
import { isDirEntry, type TreeEntry } from '../../../../core/hf_hub/tree_entry.ts'
import { hubFor, repoTypeOf, requireOperands, textOut } from './accessor.ts'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

/**
 * Which repo paths a download line asks for.
 *
 * Named files win outright: upstream downloads exactly those and does not then
 * filter them, so --include only ever narrows a whole-repo download.
 */
export function selected(
  tree: Map<string, TreeEntry>,
  names: readonly string[],
  include: readonly string[],
  exclude: readonly string[],
): string[] {
  let files = [...tree.entries()]
    .filter(([, entry]) => !isDirEntry(entry))
    .map(([path]) => path)
    .sort(compareCodePoints)
  if (names.length > 0) {
    const wanted = new Set(names)
    return files.filter((path) => wanted.has(path))
  }
  if (include.length > 0) {
    files = files.filter((path) => include.some((pattern) => fnmatch(path, pattern)))
  }
  if (exclude.length > 0) {
    files = files.filter((path) => !exclude.some((pattern) => fnmatch(path, pattern)))
  }
  return files
}

/**
 * Create a directory and every missing directory above it.
 *
 * Written out rather than delegated to `mkdir -p` because the parents flag is
 * a per-backend capability: the ops factory only wires `parents: true` for
 * backends that declare it, so a plain `mkdir` of `a/b` fails on the rest.
 */
export async function ensureDir(dispatch: DispatchFn, path: string): Promise<void> {
  const missing: string[] = []
  let current = path.replace(/\/+$/, '')
  while (current !== '' && current !== '/') {
    try {
      await dispatch('stat', PathSpec.fromStrPath(current))
      break
    } catch (err) {
      if (!isMissingPath(err)) throw err
      missing.push(current)
      current = parent(current)
    }
  }
  for (const target of missing.reverse()) {
    try {
      await dispatch('mkdir', PathSpec.fromStrPath(target))
    } catch (err) {
      // A parallel download fans out over files that share parents, so two
      // workers can read the same parent as missing and then both create
      // it. EEXIST here says the directory is present, which is what the
      // caller asked for; rethrowing would fail the whole Promise.all over
      // a race that already succeeded.
      if ((err as { code?: unknown }).code !== 'EEXIST') throw err
    }
  }
}

/** Fetch one file and store it under the workspace directory. */
async function writeFile(
  dispatch: DispatchFn,
  accessor: HfHubAccessor,
  repoPath: string,
  localDir: string,
): Promise<string> {
  const url = resolveUrl(
    accessor.endpoint,
    accessor.repoType,
    accessor.repoId,
    accessor.revision,
    repoPath,
  )
  const data = await hubBytes(accessor.token, url)
  const target = `${localDir}/${repoPath}`
  await ensureDir(dispatch, parent(target))
  await dispatch('write', PathSpec.fromStrPath(target), [data])
  return target
}

/** Whether anything is at a virtual path. */
async function pathExists(dispatch: DispatchFn, path: string): Promise<boolean> {
  try {
    await dispatch('stat', PathSpec.fromStrPath(path))
  } catch (err) {
    if (isMissingPath(err)) return false
    throw err
  }
  return true
}

/**
 * Put one file in the cache and link it into the snapshot.
 *
 * The bytes land once, under their content address, and the snapshot entry is
 * a symlink to them. That is upstream's layout and its whole point: two
 * revisions of an unchanged file share one copy, and a second download of a
 * file already held costs a stat rather than a transfer. mirage can render it
 * because a symlink here is namespace state, so no backend has to support one.
 */
async function cacheFile(
  dispatch: DispatchFn,
  accessor: HfHubAccessor,
  entry: TreeEntry,
  cacheDir: string,
  folder: string,
  sha: string,
  force: boolean,
): Promise<string> {
  const etag = etagOf(entry)
  const blob = blobPath(cacheDir, folder, etag)
  if (force || !(await pathExists(dispatch, blob))) {
    const url = resolveUrl(
      accessor.endpoint,
      accessor.repoType,
      accessor.repoId,
      accessor.revision,
      entry.path,
    )
    const data = await hubBytes(accessor.token, url)
    await ensureDir(dispatch, parent(blob))
    await dispatch('write', PathSpec.fromStrPath(blob), [data])
  }
  const link = snapshotPath(cacheDir, folder, sha, entry.path)
  if (force || !(await pathExists(dispatch, link))) {
    await ensureDir(dispatch, parent(link))
    try {
      await dispatch('unlink', PathSpec.fromStrPath(link))
    } catch (err) {
      if (!isMissingPath(err)) throw err
    }
    await dispatch('symlink', PathSpec.fromStrPath(link), [], {
      target: linkTarget(entry.path, etag),
    })
  }
  return link
}

/** Populate the cache for one revision, bounded the same way. */
async function fetchIntoCache(
  dispatch: DispatchFn,
  accessor: HfHubAccessor,
  tree: Map<string, TreeEntry>,
  paths: readonly string[],
  cacheDir: string,
  force: boolean,
  workers: number,
): Promise<[string, string[]]> {
  const sha = (await headCommit(accessor)) || accessor.revision
  const folder = repoFolderName(accessor.repoId, accessor.repoType)
  // Only a SYMBOLIC revision earns a ref. Upstream's
  // `_cache_commit_hash_for_specific_revision` is explicit that it "does
  // nothing if `revision` is already a proper `commit_hash`", so a sha-pinned
  // download writes no ref at all; writing one produced a self-referential
  // `refs/<sha>` holding its own name, which the real binary never leaves
  // behind.
  if (accessor.revision !== sha) {
    const ref = refPath(cacheDir, folder, accessor.revision)
    await ensureDir(dispatch, parent(ref))
    await dispatch('write', PathSpec.fromStrPath(ref), [new TextEncoder().encode(sha)])
  }
  const written = new Array<string>(paths.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < paths.length; i = next++) {
      const path = paths[i] ?? ''
      const entry = tree.get(path)
      if (entry === undefined) continue
      written[i] = await cacheFile(dispatch, accessor, entry, cacheDir, folder, sha, force)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, workers), paths.length) }, worker))
  return [snapshotDir(cacheDir, folder, sha), written]
}

/**
 * Refuse a line written in upstream's variadic option form.
 *
 * Upstream declares --include and --exclude as `nargs='*'`, so
 * `--include "*.json" "*.txt"` gives both patterns to the flag. mirage's
 * grammar has no variadic option value (POSIX presents multiple
 * option-arguments as one argument, so the spec layer has no shape for it),
 * and the second word lands as a filename operand instead. Since named files
 * win outright, that line would silently look for a file literally called
 * `*.txt` and report no match, so it is refused with the spelling that works.
 *
 * `patterns` is what the option itself received, so the message can show the
 * whole line rewritten rather than the stray word twice.
 */
export function refuseVariadic(
  names: readonly string[],
  flag: string,
  patterns: readonly string[],
): void {
  const stray = names.filter((name) => GLOB_CHARS.some((ch) => name.includes(ch)))
  if (stray.length === 0) return
  const rewritten = [...patterns, ...stray].map((pattern) => `${flag} '${pattern}'`).join(' ')
  throw new UsageError(
    `${flag} takes one pattern per occurrence: write ${rewritten}, ` +
      `not several after one ${flag}`,
  )
}

/**
 * Download every selected file, a bounded number at a time.
 *
 * Upstream downloads with a worker pool for the same reason: a repository is
 * many small files and one round trip each is the whole cost. The bound is the
 * point, not the parallelism, since the Hub rate-limits its resolvers;
 * `--max-workers` names it the way upstream does.
 */
async function fetchAll(
  dispatch: DispatchFn,
  accessor: HfHubAccessor,
  paths: readonly string[],
  localDir: string,
  workers: number,
): Promise<string[]> {
  const width = Math.max(1, workers)
  const written = new Array<string>(paths.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < paths.length; i = next++) {
      written[i] = await writeFile(dispatch, accessor, paths[i] ?? '', localDir)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, paths.length) }, worker))
  return written
}

/**
 * Report why nothing was selected, in the Hub's own terms.
 *
 * `fetchTree` renders an unreadable repository as an empty listing, which is
 * right for a mount and wrong here: three different failures (no such
 * repository, no such revision, no such file) would all read as "no files
 * matched". So the Hub is asked which one it was, and the wording follows
 * huggingface_hub's own errors.
 */
async function refuseAbsent(accessor: HfHubAccessor, names: readonly string[]): Promise<never> {
  const absence = await classifyAbsence(accessor)
  const url = revisionUrl(accessor)
  if (absence === Absence.REPO) {
    throw new HfHubError(
      `Repository Not Found for url: ${url}.\n` +
        'Please make sure you specified the correct `repo_id` and `repo_type`.\n' +
        'If you are trying to access a private or gated repo, make sure you are authenticated.',
      404,
      'RepoNotFound',
    )
  }
  if (absence === Absence.REVISION) {
    throw new HfHubError(
      `Revision Not Found for url: ${url}.\nInvalid rev id: ${accessor.revision}`,
      404,
      'RevisionNotFound',
    )
  }
  const first = names[0]
  if (first !== undefined) {
    const missing = resolveUrl(
      accessor.endpoint,
      accessor.repoType,
      accessor.repoId,
      accessor.revision,
      first,
    )
    throw new HfHubError(`Entry Not Found for url: ${missing}.`, 404, 'EntryNotFound')
  }
  throw new HfHubError(`No files in ${accessor.repoId} matched the line`, 404)
}

/**
 * Download files from a repository into the workspace.
 *
 * Upstream defaults to `~/.cache/huggingface`, which a workspace has no
 * equivalent of, so `--local-dir` is required rather than silently resolving
 * to a directory outside the agent's world. Downloading is also the one verb
 * the mount does better -- `cp /m/config.json .` reads the same bytes without
 * a second copy -- so this exists for the repository a workspace has not
 * mounted.
 */
export async function downloadCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  requireOperands(inv, ['repo_id'])
  const fl = new FlagView(inv.flags)
  const localDir = fl.asStr('local_dir')
  const cacheDir = fl.asStr('cache_dir') ?? cacheRoot(inv.env)
  if ((localDir === undefined || localDir === '') && (cacheDir === null || cacheDir === '')) {
    throw new UsageError(
      'nothing to download into: pass --local-dir, or --cache-dir (or set ' +
        'HF_HUB_CACHE / HF_HOME), since a workspace has no home directory to ' +
        'default a cache under',
    )
  }
  const dispatch = inv.doors?.dispatch
  if (dispatch === undefined) {
    throw new UsageError('hf download needs a workspace to write into')
  }
  const [repoId, ...names] = inv.texts
  const include = fl.asList('include')
  const exclude = fl.asList('exclude')
  if (include.length > 0) refuseVariadic(names, '--include', include)
  if (exclude.length > 0) refuseVariadic(names, '--exclude', exclude)
  const accessor = hubFor(inv, repoId ?? '', repoTypeOf(fl), fl.asStr('revision'))
  const tree = await fetchTree(accessor)
  const paths = selected(tree, names, include, exclude)
  if (paths.length === 0) await refuseAbsent(accessor, names)
  const workers = fl.asInt('max_workers') ?? MAX_DOWNLOAD_WORKERS
  let base: string
  let written: string[]
  if (localDir !== undefined && localDir !== '') {
    // A named local directory downloads straight into it, with no cache in
    // between; that is what upstream does too, which is why --force-download
    // only means anything in cache mode.
    base = localDir.replace(/\/+$/, '')
    written = await fetchAll(dispatch, accessor, paths, base, workers)
  } else {
    ;[base, written] = await fetchIntoCache(
      dispatch,
      accessor,
      tree,
      paths,
      (cacheDir ?? '').replace(/\/+$/, ''),
      fl.asBool('force_download'),
      workers,
    )
  }
  if (fl.asBool('quiet')) return textOut(`${base}\n`)
  const body = written.map((p) => `${p}\n`).join('')
  return textOut(`${body}${base}\n`)
}
