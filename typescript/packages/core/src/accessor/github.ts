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

import { HttpGitHubTransport, type GitHubTransport } from '../core/github/client.ts'
import type { GhConfig } from '../core/github/config.ts'
import { API_BASE, RAW_BASE } from '../core/github/constants.ts'
import type { TreeEntry } from '../core/github/tree_entry.ts'
import { Accessor } from './base.ts'
import { rstripSlash } from '../utils/slash.ts'

/**
 * One GitHub account: credential, API base and the transport its calls ride. A gh
 * install's accessor, and the account a github mount holds. A mount's may name
 * neither credential, to read a public repository anonymously.
 */
export class GitHubAccount extends Accessor {
  transport: GitHubTransport

  constructor(
    readonly config: GhConfig,
    transport?: GitHubTransport,
  ) {
    super()
    this.transport = transport ?? new HttpGitHubTransport(config)
  }

  /** The REST base its calls go to: github.com's when none is set. */
  get apiBase(): string {
    return rstripSlash(this.config.baseUrl ?? API_BASE)
  }

  /** Whether it holds neither a token nor an App, so its calls carry no Authorization. */
  get anonymous(): boolean {
    return this.config.token === undefined && this.config.app === undefined
  }

  /**
   * Where a file's bytes are downloaded instead of asked by blob:
   * raw.githubusercontent.com for an anonymous account on github.com, whose
   * blob requests would each spend the REST limit; null for an account with a
   * credential, or on a GitHub Enterprise host. Mirrors Python's `raw_base`.
   */
  get rawBase(): string | null {
    return this.anonymous && this.apiBase === API_BASE ? RAW_BASE : null
  }

  /**
   * The account behind a peer (a gh install's, or a github mount's) on this
   * API base; null for any other.
   */
  private peer(peer: Accessor): GitHubAccount | null {
    const account = peer instanceof GitHubAccessor ? peer.account : peer
    return account instanceof GitHubAccount && account.apiBase === this.apiBase ? account : null
  }

  /**
   * Ride the transport (its write limiter, and an App's tokens) of a peer
   * account, a gh install's or a github mount's, on the same credential and
   * API base.
   */
  override join(peers: readonly Accessor[]): void {
    for (const peer of peers) {
      const account = this.peer(peer)
      if (
        account !== null &&
        account !== this &&
        account.config.token === this.config.token &&
        JSON.stringify(account.config.app) === JSON.stringify(this.config.app)
      ) {
        this.transport = account.transport
        return
      }
    }
  }

  /**
   * Whether a write through this account may change what `peer` reads: only a
   * GitHub account or repository on the same API base, whatever token it reads
   * with, since two tokens can reach one repository. Mirrors Python's
   * `GitHubAccount.reaches`.
   */
  override reaches(peer: Accessor): boolean {
    return this.peer(peer) !== null
  }
}

/** A github mount's repository, reached through the account it holds. */
export class GitHubAccessor extends Accessor {
  readonly account: GitHubAccount
  readonly owner: string
  readonly repo: string
  ref: string | null
  defaultBranch: string | null
  branchPending: Promise<string> | null = null
  treePending: Promise<void> | null = null
  treeLoaded: boolean
  // The recursive git tree, which is this mount's whole listing. grep's
  // scope counter and code search read it straight. Reseated by every
  // listing, so it is as fresh as the last one.
  truncated: boolean
  tree: Record<string, TreeEntry>
  // The commit that tree was listed at, null until a listing names one.
  head: string | null
  // Bumped by forget, so a tree GitHub answered before the drop is handed
  // back to its caller but not reseated.
  generation = 0

  constructor(opts: {
    account: GitHubAccount
    owner: string
    repo: string
    ref?: string
    defaultBranch?: string
    truncated?: boolean
    tree?: Record<string, TreeEntry>
    head?: string
  }) {
    super()
    this.account = opts.account
    this.owner = opts.owner
    this.repo = opts.repo
    this.ref = opts.ref ?? null
    this.defaultBranch = opts.defaultBranch ?? null
    this.treeLoaded = opts.tree !== undefined
    this.truncated = opts.truncated ?? false
    this.tree = opts.tree ?? {}
    this.head = opts.head ?? null
  }

  get isDefaultBranch(): boolean {
    return this.ref !== null && this.ref === this.defaultBranch
  }

  /** Drop the tree with the mount's caches, so the next listing fetches it again. */
  override forget(): void {
    super.forget?.()
    this.generation += 1
    this.tree = {}
    this.treeLoaded = false
    this.treePending = null
    this.truncated = false
    this.head = null
  }
}
