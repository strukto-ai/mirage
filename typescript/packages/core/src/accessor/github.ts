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

import { Accessor } from './base.ts'
import type { GitHubTransport } from '../core/github/_client.ts'
import type { TreeEntry } from '../core/github/tree_entry.ts'
import type { Resource } from '../resource/base.ts'

export class GitHubAccessor extends Accessor {
  readonly transport: GitHubTransport
  readonly owner: string
  readonly repo: string
  readonly ref: string
  readonly defaultBranch: string
  // Reseated by GitHubResource.refresh: the tree is the mount's whole
  // listing, so a refetch after a write replaces it wholesale.
  truncated: boolean
  tree: Record<string, TreeEntry>

  constructor(opts: {
    transport: GitHubTransport
    owner: string
    repo: string
    ref: string
    defaultBranch: string
    truncated?: boolean
    tree?: Record<string, TreeEntry>
  }) {
    super()
    this.transport = opts.transport
    this.owner = opts.owner
    this.repo = opts.repo
    this.ref = opts.ref
    this.defaultBranch = opts.defaultBranch
    this.truncated = opts.truncated ?? false
    this.tree = opts.tree ?? {}
  }

  get isDefaultBranch(): boolean {
    return this.ref === this.defaultBranch
  }
}

export interface GitHubResourceLike extends Resource {
  readonly accessor: GitHubAccessor
}
