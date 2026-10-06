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

import { joinSpec } from '@struktoai/mirage-core/utils/path'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { REPO_ID_SEPARATOR } from './constants.ts'
import type { TreeEntry } from './tree_entry.ts'

/**
 * The one flat directory a repository's cache lives under.
 *
 * Upstream's own spelling (`file_download.repo_folder_name`): the plural kind
 * and the two halves of the id joined by `--`, so `julien-c/EsperBERTo-small`
 * as a model is `models--julien-c--EsperBERTo-small`. Flattening is the point:
 * a namespace holding a slash would otherwise nest, and two repos could
 * collide across kinds.
 */
export function repoFolderName(repoId: string, repoType: string): string {
  return [`${repoType}s`, ...repoId.split('/')].join(REPO_ID_SEPARATOR)
}

/**
 * The name a file's bytes are cached under.
 *
 * Upstream keys a blob by the ETag the resolve endpoint answered, which is the
 * LFS sha256 for a pointer-backed file and the git blob oid for an ordinary
 * one. Both are content addresses, which is what makes the blob shareable
 * between revisions: two snapshots of an unchanged file link to one blob.
 */
export function etagOf(entry: TreeEntry): string {
  return entry.lfsOid !== '' ? entry.lfsOid : entry.oid
}

/** Where one file's bytes live, shared across every snapshot. */
export function blobPath(cacheDir: string | PathSpec, folder: string, etag: string): PathSpec {
  return joinSpec(cacheDir, folder, 'blobs', etag)
}

/** The directory one commit's tree is rendered under. */
export function snapshotDir(cacheDir: string | PathSpec, folder: string, sha: string): PathSpec {
  return joinSpec(cacheDir, folder, 'snapshots', sha)
}

/** Where one file appears within a commit's rendered tree. */
export function snapshotPath(
  cacheDir: string | PathSpec,
  folder: string,
  sha: string,
  repoPath: string,
): PathSpec {
  return joinSpec(snapshotDir(cacheDir, folder, sha), repoPath)
}

/** The file recording which commit a branch or tag points at. */
export function refPath(cacheDir: string | PathSpec, folder: string, revision: string): PathSpec {
  return joinSpec(cacheDir, folder, 'refs', revision)
}

/**
 * The relative target a snapshot entry points at.
 *
 * Relative, not absolute, because upstream's cache is relocatable: a whole
 * cache directory can be moved or copied and every link still resolves.
 * Derived from the entry's own depth rather than counted out, so a nested path
 * cannot get the number of `..` hops wrong.
 */
export function linkTarget(repoPath: string, etag: string): string {
  const depth = repoPath.split('/').length - 1
  return `${'../'.repeat(depth + 2)}blobs/${etag}`
}

/**
 * The cache root the session names, in upstream's own order.
 *
 * Upstream reads `HF_HUB_CACHE` first and falls back to `HF_HOME/hub`, then to
 * `~/.cache/huggingface/hub`. A workspace has no home directory, so the last
 * step is the one that cannot be taken and the caller reports that rather than
 * inventing a path.
 */
export function cacheRoot(env: Readonly<Record<string, string>>): string | null {
  const direct = env.HF_HUB_CACHE
  if (direct !== undefined && direct !== '') return direct
  const home = env.HF_HOME
  return home !== undefined && home !== '' ? `${home}/hub` : null
}
