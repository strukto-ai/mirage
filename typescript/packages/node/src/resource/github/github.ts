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

import {
  BaseResource,
  fetchGitHubRepoInfo,
  fetchGitHubTree,
  type FileStat,
  GITHUB_COMMANDS,
  GITHUB_VFS_OPS,
  type GitHubTreeItem,
  GitHubAccessor,
  HttpGitHubTransport,
  type IndexCacheStore,
  type IndexEntry,
  PathSpec,
  RAMIndexCacheStore,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  githubIndexEntryFromTree,
  githubMakeTreeEntry,
  githubRead,
  githubReaddir,
  githubResolveGlob,
  githubStat,
  type GitHubTreeEntry,
} from '@struktoai/mirage-core'
import { redactGitHubConfig, type GitHubConfig, type GitHubConfigRedacted } from './config.ts'

export interface GitHubResourceState {
  type: string
  config: GitHubConfigRedacted
  defaultBranch: string
  truncated: boolean
}

export class GitHubResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.GITHUB
  readonly isRemote: boolean = true
  readonly indexTtl: number = 86_400
  readonly config: GitHubConfig
  readonly accessor: GitHubAccessor

  private constructor(config: GitHubConfig, accessor: GitHubAccessor, index: IndexCacheStore) {
    super()
    this.config = config
    this.accessor = accessor
    this._index = index
  }

  static async create(config: GitHubConfig): Promise<GitHubResource> {
    const transportOpts: { token: string; baseUrl?: string } = { token: config.token }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const transport = new HttpGitHubTransport(transportOpts)
    const repoInfo = await fetchGitHubRepoInfo(transport, config.owner, config.repo)
    const ref = config.ref ?? repoInfo.default_branch
    const { tree, truncated } = await fetchGitHubTree(transport, config.owner, config.repo, ref)
    const treeMap: Record<string, GitHubTreeEntry> = {}
    for (const item of tree) treeMap[item.path] = githubMakeTreeEntry(item)
    const accessor = new GitHubAccessor({
      transport,
      owner: config.owner,
      repo: config.repo,
      ref,
      defaultBranch: repoInfo.default_branch,
      truncated,
      tree: treeMap,
    })
    const index = new RAMIndexCacheStore({ ttl: 86_400 })
    await populateIndex(index, tree)
    return new GitHubResource(config, accessor, index)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GITHUB_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GITHUB_VFS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return githubRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return githubReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return githubStat(this.accessor, p, this.index)
  }

  async fingerprint(p: PathSpec): Promise<string | null> {
    const lookup = await this.index.get(p.original)
    return lookup.entry?.id ?? null
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            p.prefix !== ''
              ? p
              : new PathSpec({
                  original: p.original,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  prefix,
                }),
          )
        : paths
    return githubResolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<GitHubResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGitHubConfig(this.config),
      defaultBranch: this.accessor.defaultBranch,
      truncated: this.accessor.truncated,
    })
  }

  loadState(_state: GitHubResourceState): Promise<void> {
    return Promise.resolve()
  }
}

async function populateIndex(index: IndexCacheStore, tree: GitHubTreeItem[]): Promise<void> {
  const dirs = new Map<string, [string, IndexEntry][]>()
  for (const item of tree) {
    const parts = item.path.split('/')
    const name = parts[parts.length - 1] ?? item.path
    const parent = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '/'
    const arr = dirs.get(parent) ?? []
    arr.push([name, githubIndexEntryFromTree(item)])
    dirs.set(parent, arr)
  }
  await Promise.all([...dirs].map(([parent, entries]) => index.setDir(parent, entries)))
}
