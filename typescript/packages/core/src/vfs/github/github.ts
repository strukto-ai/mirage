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

import { BaseVFS } from '../base.ts'
import { GitHubAccessor } from '../../accessor/github.ts'

import {
  HttpGitHubTransport,
  fetchRepoInfo as fetchGitHubRepoInfo,
} from '../../core/github/client.ts'

import {
  buildTreeMap as githubBuildTreeMap,
  fetchTree as fetchGitHubTree,
} from '../../core/github/tree.ts'
import { buildDeltaHook } from '../../core/github/watch.ts'

import { PROMPT } from './prompt.ts'
import { COMMIT_SHA } from '../../core/github/constants.ts'
import { ListingVersion, VFSName } from '../../types.ts'

import type { DeltaHook } from '../../watch/index.ts'
import {
  redactGitHubConfig,
  type GitHubConfig,
  type GitHubConfigRedacted,
} from '../../core/github/config.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir as githubReaddir } from '../../core/github/readdir.ts'
import { read as githubRead } from '../../core/github/read.ts'
import { stat as githubStat } from '../../core/github/stat.ts'
import {
  beforeFullScan as githubBeforeFullScan,
  filesContaining as githubFilesContaining,
} from '../../core/github/search.ts'
import type { ScanReason } from '../types.ts'
import { SCOPE_ERROR } from '../../core/github/constants.ts'

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
  override readonly prompt: string = PROMPT
  readonly config: GitHubConfig
  override readonly accessor: GitHubAccessor

  private constructor(config: GitHubConfig, accessor: GitHubAccessor) {
    super()
    this.config = config
    this.accessor = accessor
    this.listingsPin = pinOf(config.ref)
  }

  static async create(config: GitHubConfig): Promise<GitHubVFS> {
    const transportOpts: { token: string; baseUrl?: string } = { token: config.token }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const transport = new HttpGitHubTransport(transportOpts)
    const repoInfo = await fetchGitHubRepoInfo(transport, config.owner, config.repo)
    const ref = config.ref ?? repoInfo.default_branch
    const { tree, truncated, sha } = await fetchGitHubTree(
      transport,
      config.owner,
      config.repo,
      ref,
    )
    const treeMap = githubBuildTreeMap(tree)
    const accessor = new GitHubAccessor({
      transport,
      owner: config.owner,
      repo: config.repo,
      ref,
      defaultBranch: repoInfo.default_branch,
      truncated,
      tree: treeMap,
      treeVersion: truncated ? null : sha,
    })
    return new GitHubVFS(config, accessor)
  }

  override readonly maxGlobMatches: number = SCOPE_ERROR

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return githubReaddir(this.accessor, path, index)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await githubRead(this.accessor, path, index)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return githubStat(this.accessor, path, index)
  }

  override filesContaining(
    text: string,
    under: PathSpec[],
    opts: { wholeWord: boolean; ignoreCase: boolean },
    index?: IndexCacheStore,
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord) return Promise.resolve(null)
    return githubFilesContaining(this.accessor, text, under, index)
  }

  override beforeFullScan(
    _command: string,
    under: PathSpec[],
    reason: ScanReason,
    index?: IndexCacheStore,
  ): Promise<void> {
    return githubBeforeFullScan(this.accessor, under, reason, index)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
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
