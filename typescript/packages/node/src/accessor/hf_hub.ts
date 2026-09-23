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

import { Accessor } from '@struktoai/mirage-core/accessor/index'
import type { IndexEntry } from '@struktoai/mirage-core/cache/index/config'
import { VFSName } from '@struktoai/mirage-core/types'
import * as kp from '@struktoai/mirage-core/utils/key_prefix'
import { HF_ENDPOINT, type HfRepoConfig } from '../vfs/hf_buckets/config.ts'
import { DEFAULT_REVISION } from '../core/hf_hub/constants.ts'
import type { TreeEntry } from '../core/hf_hub/tree_entry.ts'

export interface RowTables {
  entries: Map<string, IndexEntry>
  children: Map<string, string[]>
}

/**
 * A mount onto one Hugging Face Hub repository.
 *
 * Holds the whole repository tree: the Hub's listing endpoint is recursive,
 * so one paged walk is the mount's entire listing and every read after it is
 * a lookup. find and du read that tree directly; everything else goes through
 * the index it seeds.
 *
 * Constructed without touching the network. A constructor cannot await, so
 * fetching here would mean a blocking client stalling whatever loop the
 * caller is on; the tree hydrates on first use instead.
 */
export class HfHubAccessor extends Accessor {
  /** The recursive tree, keyed mount-relative with no leading slash and with
   * keyPrefix already stripped. Reseated by every refill. */
  tree = new Map<string, TreeEntry>()
  /** Whether that tree is an answer or just the empty default, which is a
   * different question from whether it holds anything: an empty repository
   * hydrates to an empty map, and reading that as "not hydrated" refetches it
   * forever. */
  treeLoaded = false
  /** The index tables derived from that tree, for a mount with no index
   * wired. Derivation is O(tree), so a readdir loop over a large repo would
   * be quadratic without a memo; every reseat of `tree` clears it. */
  rowsCache: { prefix: string; rows: RowTables } | null = null
  /** Guards the lazy hydration so concurrent first reads make one request
   * rather than one per caller. */
  hydrating: Promise<void> | null = null

  constructor(
    readonly config: HfRepoConfig,
    private readonly kind = 'model',
    readonly vfsName: VFSName = VFSName.HF_MODELS,
  ) {
    super()
  }

  get repoType(): string {
    return this.kind
  }

  get repoId(): string {
    return this.config.repoId
  }

  get endpoint(): string {
    return this.config.endpoint ?? HF_ENDPOINT
  }

  get token(): string | undefined {
    return this.config.token
  }

  /**
   * The revision this mount reads.
   *
   * Resolved without a request, unlike GitHub's default branch: the Hub
   * creates every repository with `main` and offers no way to change which
   * branch is default, so naming no revision means that branch and nothing
   * has to be asked.
   */
  get revision(): string {
    const pinned = this.config.revision
    return pinned === undefined || pinned === '' ? DEFAULT_REVISION : pinned
  }

  /** Normalized WITH a trailing slash, which is what `kp.strip` expects. */
  get keyPrefix(): string {
    return kp.normalize(this.config.keyPrefix)
  }

  get expandCommits(): boolean | undefined {
    return this.config.expandCommits
  }

  get bucketUri(): string {
    return `hf://${this.repoType}s/${this.repoId}`
  }

  /**
   * Lift a mount-relative path to its repo-relative spelling.
   *
   * `keyPrefix` is normalized with a TRAILING slash, so joining with one of
   * our own produced `sub/dir//a.txt` and every read of a prefixed mount
   * 404'd.
   */
  repoPath(rel: string): string {
    const prefix = this.keyPrefix
    const stem = rel.replace(/^\/+|\/+$/g, '')
    if (prefix === '') return stem
    if (stem === '') return prefix.replace(/\/+$/, '')
    return kp.apply(prefix, rel).replace(/\/+$/, '')
  }
}

export class HfModelsHubAccessor extends HfHubAccessor {
  constructor(config: HfRepoConfig) {
    super(config, 'model', VFSName.HF_MODELS)
  }
}

export class HfDatasetsHubAccessor extends HfHubAccessor {
  constructor(config: HfRepoConfig) {
    super(config, 'dataset', VFSName.HF_DATASETS)
  }
}

export class HfSpacesHubAccessor extends HfHubAccessor {
  constructor(config: HfRepoConfig) {
    super(config, 'space', VFSName.HF_SPACES)
  }
}
