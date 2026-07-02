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

import { mountKey, mountPrefixOf } from '@struktoai/mirage-core'
import {
  type FileStat,
  GITHUB_CI_COMMANDS,
  GITHUB_CI_PROMPT,
  GITHUB_CI_VFS_OPS,
  GitHubCIAccessor,
  HttpCITransport,
  type IndexCacheStore,
  PathSpec,
  RAMIndexCacheStore,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  githubCiRead,
  githubCiReaddir,
  githubCiResolveGlob,
  githubCiStat,
} from '@struktoai/mirage-core'
import { redactGitHubCIConfig, type GitHubCIConfig, type GitHubCIConfigRedacted } from './config.ts'

export interface GitHubCIResourceState {
  type: string
  config: GitHubCIConfigRedacted
}

export class GitHubCIResource implements Resource {
  readonly kind: string = ResourceName.GITHUB_CI
  readonly cachesReads: boolean = true
  readonly indexTtl: number = 86_400
  readonly prompt: string = GITHUB_CI_PROMPT
  readonly config: GitHubCIConfig
  readonly accessor: GitHubCIAccessor
  readonly index: IndexCacheStore

  constructor(config: GitHubCIConfig) {
    this.config = config
    const transportOpts: { token: string; baseUrl?: string } = { token: config.token }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    this.accessor = new GitHubCIAccessor({
      transport: new HttpCITransport(transportOpts),
      owner: config.owner,
      repo: config.repo,
      days: config.days ?? 30,
    })
    this.index = new RAMIndexCacheStore({ ttl: 86_400 })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GITHUB_CI_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GITHUB_CI_VFS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return githubCiRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return githubCiReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return githubCiStat(this.accessor, p, this.index)
  }

  async fingerprint(p: PathSpec): Promise<string | null> {
    const lookup = await this.index.get(p.virtual)
    return lookup.entry?.remoteTime ?? null
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            mountPrefixOf(p.virtual, p.resourcePath) !== ''
              ? p
              : new PathSpec({
                  virtual: p.virtual,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  resourcePath: mountKey(p.virtual, prefix),
                }),
          )
        : paths
    return githubCiResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<GitHubCIResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGitHubCIConfig(this.config),
    })
  }

  loadState(_state: GitHubCIResourceState): Promise<void> {
    return Promise.resolve()
  }
}
