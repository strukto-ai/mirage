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

import { FileType, PathSpec } from '../../../../types.ts'
import { parent, posixNormpath } from '../../../../utils/path.ts'
import { isMissingPath } from '../../../../utils/errors.ts'
import type { Dispatch } from './types.ts'

/** Read one virtual path through the workspace dispatcher. */
export async function readFile(dispatch: Dispatch, path: string): Promise<Uint8Array> {
  const [data] = await dispatch('read', PathSpec.fromStrPath(path))
  return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
}

/** Read a byte range of one virtual path. */
export async function readRange(
  dispatch: Dispatch,
  path: string,
  offset: number,
  size: number,
): Promise<Uint8Array> {
  const [data] = await dispatch('read', PathSpec.fromStrPath(path), [], { offset, size })
  return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
}

/**
 * Read a path that a repository may legitimately not have.
 *
 * `packed-refs` and `HEAD`-adjacent files are absent in perfectly valid
 * repositories, so a miss is an answer rather than an error.
 */
export async function readOptional(dispatch: Dispatch, path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(dispatch, path)
  } catch (err) {
    if (isMissingPath(err)) return null
    throw err
  }
}

/** List a directory, empty when it does not exist. */
export async function readNames(dispatch: Dispatch, path: string): Promise<string[]> {
  try {
    const [entries] = await dispatch('readdir', PathSpec.fromStrPath(path))
    return [...((entries as string[] | null) ?? [])]
  } catch (err) {
    if (isMissingPath(err)) return []
    throw err
  }
}

/**
 * Create a directory and every missing directory above it.
 *
 * Written out rather than delegated to `mkdir -p` because the parents flag is a
 * per-backend capability: the ops factory only wires `parents: true` for
 * backends that declare it, so a plain `mkdir` of `objects/ab` fails on the
 * rest.
 *
 * Existence is probed with a point stat, which on a prefix store misses a
 * directory that has no object of its own. That false negative is harmless here
 * and the reason this does not need the two-channel stat: on such a store a
 * directory is the set of keys under it, so creating one again costs a no-op
 * rather than an error.
 */
export async function ensureDir(dispatch: Dispatch, path: string): Promise<void> {
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
    await dispatch('mkdir', PathSpec.fromStrPath(target))
  }
}

/**
 * Whether a path names a directory, false when nothing is there.
 *
 * Asked with a stat rather than inferred from a failed read: a read of a
 * directory misses on a keyed store and raises EISDIR on disk, so "the read did
 * not work" says nothing about what the path is.
 */
export async function isDirectory(dispatch: Dispatch, path: string): Promise<boolean> {
  try {
    const [stat] = await dispatch('stat', PathSpec.fromStrPath(path))
    return (stat as { type?: string } | null)?.type === FileType.DIRECTORY
  } catch (err) {
    if (isMissingPath(err)) return false
    throw err
  }
}

/** Whether a point lookup finds anything at a path. */
export async function exists(dispatch: Dispatch, path: string): Promise<boolean> {
  try {
    await dispatch('stat', PathSpec.fromStrPath(path))
  } catch (err) {
    if (isMissingPath(err)) return false
    throw err
  }
  return true
}

/** Write one virtual path, creating the directories above it. */
export async function writeFile(dispatch: Dispatch, path: string, data: Uint8Array): Promise<void> {
  await ensureDir(dispatch, parent(path))
  await dispatch('write', PathSpec.fromStrPath(path), [data])
}

/**
 * Delete one virtual path, tolerating one that is already gone.
 *
 * A miss is an answer rather than an error for every caller here: unstaging a
 * path deletes whatever ref or lock may or may not exist, and a checkout removes
 * files the other branch does not have.
 */
export async function removeFile(dispatch: Dispatch, path: string): Promise<void> {
  try {
    await dispatch('unlink', PathSpec.fromStrPath(path))
  } catch (err) {
    if (!isMissingPath(err)) throw err
  }
}

/** Join path segments below a git directory, POSIX style. */
export function under(base: string, ...parts: string[]): string {
  return posixNormpath(`${base}/${parts.join('/')}`)
}
