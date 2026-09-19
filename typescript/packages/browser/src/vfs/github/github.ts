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

import { GitHubAccessor } from '@struktoai/mirage-core/accessor/github'
import { GITHUB_COMMANDS } from '@struktoai/mirage-core/commands/builtin/github/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import {
  HttpGitHubTransport,
  fetchRepoInfo as fetchGitHubRepoInfo,
  fetchTree as fetchGitHubTree,
} from '@struktoai/mirage-core/core/github/client'
import { buildTreeMap as githubBuildTreeMap } from '@struktoai/mirage-core/core/github/tree'
import { buildDeltaHook } from '@struktoai/mirage-core/core/github/watch'
import { GITHUB_OPS } from '@struktoai/mirage-core/ops/github/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { GITHUB_PROMPT } from '@struktoai/mirage-core/vfs/github/prompt'
import { VFSName } from '@struktoai/mirage-core/types'
import type { DeltaHook } from '@struktoai/mirage-core/watch/index'
import {
  redactGitHubConfig,
  type GitHubConfig,
  type GitHubConfigRedacted,
} from '@struktoai/mirage-core/core/github/config'
export interface GitHubVFSState {
  type: string
  config: GitHubConfigRedacted
  defaultBranch: string
  truncated: boolean
}

export class GitHubVFS extends BaseVFS {
  override readonly name: string = VFSName.GITHUB
  override readonly cachesReads: boolean = true
  // The git tree API reports the exact blob size for every file; the
  // blob read returns those same bytes, and submodule gitlinks (which
  // have no size and no blob) are excluded from the tree.
  override readonly sizesAlwaysKnown: boolean = true
  // Blob shas are stable per-path markers, so cached reads can be
  // probe-verified under ALWAYS and snapshots carry drift fingerprints.
  override readonly supportsSnapshot: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = GITHUB_PROMPT
  readonly config: GitHubConfig
  override readonly accessor: GitHubAccessor

  private constructor(config: GitHubConfig, accessor: GitHubAccessor) {
    super()
    this.config = config
    this.accessor = accessor
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
    return new GitHubVFS(config, accessor)
  }
  override commands(): readonly RegisteredCommand[] {
    return GITHUB_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return GITHUB_OPS
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

  override loadState(_state: GitHubVFSState): Promise<void> {
    return Promise.resolve()
  }
}
