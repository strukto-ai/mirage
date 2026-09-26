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

import { BoundVFS } from '../bound.ts'
import { GITHUB_IO } from '../../commands/builtin/github/io.ts'
import { GitHubAccessor } from '../../accessor/github.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'

import { GITHUB_COMMANDS } from '../../commands/builtin/github/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import {
  HttpGitHubTransport,
  fetchRepoInfo as fetchGitHubRepoInfo,
  fetchTree as fetchGitHubTree,
} from '../../core/github/client.ts'

import { buildTreeMap as githubBuildTreeMap } from '../../core/github/tree.ts'
import { buildDeltaHook } from '../../core/github/watch.ts'
import { GITHUB_OPS } from '../../ops/github/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'

import type { VFS } from '../base.ts'
import { GITHUB_PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import type { DeltaHook } from '../../watch/index.ts'
import {
  redactGitHubConfig,
  type GitHubConfig,
  type GitHubConfigRedacted,
} from '../../core/github/config.ts'

export interface GitHubVFSState {
  type: string
  config: GitHubConfigRedacted
  defaultBranch: string
  truncated: boolean
}

export class GitHubVFS extends BoundVFS<GitHubAccessor> implements VFS {
  readonly kind: string = VFSName.GITHUB
  readonly cachesReads: boolean = true
  // The git tree API reports the exact blob size for every file; the
  // blob read returns those same bytes, and submodule gitlinks (which
  // have no size and no blob) are excluded from the tree.
  readonly sizesAlwaysKnown: boolean = true
  // A read records the blob sha it fetched and stat reports the same sha,
  // so a snapshot can pin it and `read: fresh` can compare the two. git is
  // content-addressed: identical bytes carry an identical sha.
  readonly supportsSnapshot: boolean = true
  readonly readRevalidatable: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GITHUB_PROMPT
  readonly config: GitHubConfig
  readonly accessor: GitHubAccessor

  private constructor(config: GitHubConfig, accessor: GitHubAccessor, index: IndexCacheStore) {
    super(GITHUB_IO)
    this.config = config
    this.accessor = accessor
    this._index = index
  }

  static async create(config: GitHubConfig): Promise<GitHubVFS> {
    const transportOpts: { token: string; baseUrl?: string } = { token: config.token }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const transport = new HttpGitHubTransport(transportOpts)
    const repoInfo = await fetchGitHubRepoInfo(transport, config.owner, config.repo)
    const ref = config.ref ?? repoInfo.default_branch
    const { tree, truncated } = await fetchGitHubTree(transport, config.owner, config.repo, ref)
    const treeMap = githubBuildTreeMap(tree)
    const accessor = new GitHubAccessor({
      transport,
      owner: config.owner,
      repo: config.repo,
      ref,
      defaultBranch: repoInfo.default_branch,
      truncated,
      tree: treeMap,
    })
    // Not seeded here: the index is keyed by mount prefix, which only a
    // PathSpec knows, so the first read seeds it from the accessor's tree.
    const index = new RAMIndexCacheStore({ ttl: 86_400 })
    return new GitHubVFS(config, accessor, index)
  }

  commands(): readonly RegisteredCommand[] {
    return GITHUB_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GITHUB_OPS
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<GitHubVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGitHubConfig(this.config),
      defaultBranch: this.accessor.defaultBranch,
      truncated: this.accessor.truncated,
    })
  }
}
