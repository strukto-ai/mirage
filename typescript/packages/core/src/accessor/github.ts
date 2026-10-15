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
import type { GitHubTransport } from '../core/github/client.ts'
import type { TreeEntry } from '../core/github/tree_entry.ts'

export class GitHubAccessor extends Accessor {
  readonly transport: GitHubTransport
  readonly owner: string
  readonly repo: string
  readonly ref: string
  readonly defaultBranch: string
  // The recursive git tree, which is this mount's whole listing. grep's
  // scope counter and code search read it straight. Reseated by every
  // listing, so it is as fresh as the last one.
  truncated: boolean
  tree: Record<string, TreeEntry>
  // The head commit that tree was fetched at, as the response named it, or
  // null when it is not known (a truncated or sha-less response). Every
  // listing out of the tree carries it as its version.
  treeVersion: string | null

  constructor(opts: {
    transport: GitHubTransport
    owner: string
    repo: string
    ref: string
    defaultBranch: string
    truncated?: boolean
    tree?: Record<string, TreeEntry>
    treeVersion?: string | null
  }) {
    super()
    this.transport = opts.transport
    this.owner = opts.owner
    this.repo = opts.repo
    this.ref = opts.ref
    this.defaultBranch = opts.defaultBranch
    this.truncated = opts.truncated ?? false
    this.tree = opts.tree ?? {}
    this.treeVersion = opts.treeVersion ?? null
  }

  get isDefaultBranch(): boolean {
    return this.ref === this.defaultBranch
  }
}
