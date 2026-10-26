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

import { type ByteSource } from '../../io/types.ts'
import { BaseVFS } from '../base.ts'
import { GitHubAccessor, GitHubAccount } from '../../accessor/github.ts'

import { fetchRepoInfo as fetchGitHubRepoInfo } from '../../core/github/client.ts'

import {
  buildTreeMap as githubBuildTreeMap,
  fetchTree as fetchGitHubTree,
} from '../../core/github/tree.ts'

import { COMMIT_SHA, WALK_LIMIT } from '../../core/github/constants.ts'
import { ListingVersion, VFSName } from '../../types.ts'

import {
  redactGitHubConfig,
  type GitHubConfig,
  type GitHubConfigRedacted,
} from '../../core/github/config.ts'
import type { DirListing, PathSpec, FileStat } from '../../types.ts'
import type { Handed } from '../types.ts'
import { readdir as githubReaddir } from '../../core/github/readdir.ts'
import { readMany as githubReadMany, readStream as githubStream } from '../../core/github/read.ts'
import { stat as githubStat, tree as githubTree } from '../../core/github/stat.ts'
import { filesContaining as githubFilesContaining } from '../../core/github/search.ts'

export interface GitHubVFSState {
  type: string
  config: GitHubConfigRedacted
  defaultBranch: string
  truncated: boolean
}

/**
 * The commit a ref pins every listing at, when it names one outright. Only a
 * full 40- or 64-hex string can be a commit; GitHub answers shas lowercase,
 * so the pin is lowercased to compare with what it stores. Listings are
 * stored at the head their tree answered, so a ref is served unchecked only
 * when its listing was fetched at that sha. github.com refuses a branch or
 * tag named with 40 or 64 hex characters (HTTP 422), so such a ref always
 * names a commit, which cannot move; a GitHub Enterprise host behind
 * `baseUrl` is assumed to refuse them too.
 */
function pinOf(ref: string | undefined): string | null {
  if (ref === undefined) return null
  const lowered = ref.toLowerCase()
  return COMMIT_SHA.test(lowered) ? lowered : null
}

export class GitHubVFS extends BaseVFS {
  override readonly name: string = VFSName.GITHUB
  override readonly cachesReads: boolean = true
  // The git tree API reports the exact blob size for every file; the
  // blob read returns those same bytes, and submodule gitlinks (which
  // have no size and no blob) are excluded from the tree.
  override readonly sizesAlwaysKnown: boolean = true
  // stat and a read both stamp the content-addressed blob sha.
  override readonly supportsSnapshot: boolean = true
  override readonly readRevalidatable: boolean = true
  // One version covers every listing: the head commit the ref resolves to,
  // which the tree response names as its top-level sha and the root stat
  // answers with one shallow request.
  override readonly listingVersion: ListingVersion = ListingVersion.MOUNT
  override readonly listingsPin: string | null
  override readonly indexTtl: number = 86_400
  override readonly wholeWordSearch: boolean = true
  readonly config: GitHubConfig
  override readonly accessor: GitHubAccessor
  override walkLimit: number = WALK_LIMIT

  private constructor(config: GitHubConfig, accessor: GitHubAccessor) {
    super()
    this.config = config
    this.accessor = accessor
    this.listingsPin = pinOf(config.ref)
  }

  static async create(config: GitHubConfig): Promise<GitHubVFS> {
    const account = new GitHubAccount(
      config.baseUrl === undefined
        ? { token: config.token }
        : { token: config.token, baseUrl: config.baseUrl },
    )
    const repoInfo = await fetchGitHubRepoInfo(account.transport, config.owner, config.repo)
    const ref = config.ref ?? repoInfo.default_branch
    const { tree, truncated } = await fetchGitHubTree(
      account.transport,
      config.owner,
      config.repo,
      ref,
    )
    const treeMap = githubBuildTreeMap(tree)
    const accessor = new GitHubAccessor({
      account,
      owner: config.owner,
      repo: config.repo,
      ref,
      defaultBranch: repoInfo.default_branch,
      truncated,
      tree: treeMap,
    })
    return new GitHubVFS(config, accessor)
  }

  override readonly handed = {
    readdir: ['entry'],
    read: ['entry'],
    readMany: ['entry'],
    stat: ['entry', 'index'],
  } as const

  override readdir(path: PathSpec, handed?: Handed): Promise<DirListing> {
    return githubReaddir(this.accessor, path, handed?.entry)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async read(path: PathSpec, handed?: Handed): Promise<ByteSource> {
    return githubStream(this.accessor, path, handed?.entry)
  }

  override readMany(
    paths: PathSpec[],
    limit: number,
    handed?: readonly Handed[],
  ): Promise<Map<string, Uint8Array>> {
    return githubReadMany(this.accessor, paths, limit, handed)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return githubStat(this.accessor, path, handed?.entry, handed?.index)
  }

  override readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    return githubTree(this.accessor, path)
  }

  /**
   * Whether this VFS answers `name`; with no walk limit it reads every
   * file rather than ask the service's search.
   */
  override supports(name: string): boolean {
    if (name === 'files_containing' && this.walkLimit < 0) return false
    return super.supports(name)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord || this.walkLimit < 0) return Promise.resolve(null)
    return githubFilesContaining(this.accessor, text, [path])
  }

  override getState(): Promise<GitHubVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGitHubConfig(this.config),
      defaultBranch: this.accessor.defaultBranch,
      truncated: this.accessor.truncated,
    })
  }
}
