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
import { VFSName } from '@struktoai/mirage-core/types'
import * as kp from '@struktoai/mirage-core/utils/key_prefix'
import {
  HF_ENDPOINT,
  HF_TIMEOUT_MS,
  type HfBucketsConfig,
  type HfRepoConfig,
} from '../vfs/hf_buckets/config.ts'
import { hfEndpoint, type HfConfig } from '../core/hf_hub/config.ts'
import { DEFAULT_REVISION } from '../core/hf_hub/constants.ts'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'

/**
 * One Hub account: credential, origin and the bound its requests run under.
 * The `hf` CLI's install accessor and the account a repository handle
 * borrows; a mount builds its own with `accountOf`.
 */
export class HfAccountAccessor extends Accessor {
  constructor(
    readonly config: HfConfig,
    /** How long one Hub request may go without progress. */
    readonly timeoutMs: number = HF_TIMEOUT_MS,
  ) {
    super()
  }

  get token(): string | undefined {
    return this.config.token
  }

  get endpoint(): string {
    return hfEndpoint(this.config)
  }
}

/** The account a repository or bucket mount builds and owns. */
export function accountOf(config: HfRepoConfig | HfBucketsConfig): HfAccountAccessor {
  const { token, endpoint = HF_ENDPOINT, timeoutMs } = config
  return new HfAccountAccessor(token === undefined ? { endpoint } : { token, endpoint }, timeoutMs)
}

/**
 * One Hugging Face Hub repository, over an account it borrows.
 *
 * The Hub's listing endpoint is recursive, so one paged walk is the mount's
 * entire listing, which the mount keeps; every stat and read after it is
 * handed its row.
 *
 * Constructed without touching the network. A constructor cannot await, so
 * fetching here would mean a blocking client stalling whatever loop the
 * caller is on.
 */
export class HfHubAccessor extends Accessor {
  constructor(
    readonly account: HfAccountAccessor,
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
    return this.account.endpoint
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
    const stem = stripSlash(rel)
    if (prefix === '') return stem
    if (stem === '') return rstripSlash(prefix)
    return rstripSlash(kp.apply(prefix, rel))
  }
}

/**
 * A Hub handle for one repository, over an account it borrows.
 *
 * The `hf` CLI builds one per invocation over the install's account rather
 * than owning a second Hub client: the handle only names which repository is
 * being addressed and rides the account's credential, origin and request
 * bound, so `hf` gets the mount's tree walk and commit builder for free. It
 * reaches no mount, which is what keeps `hf` an account CLI. A verb reads paths and
 * sizes, never the per-file commit a mount's mtimes come from, so the walk
 * lists bare.
 */
export function hubFor(
  account: HfAccountAccessor,
  repoId: string,
  repoType: string,
  revision?: string,
): HfHubAccessor {
  return new HfHubAccessor(
    account,
    {
      repoId,
      revision: revision === undefined || revision === '' ? DEFAULT_REVISION : revision,
      expandCommits: false,
    },
    repoType,
  )
}

export class HfModelsAccessor extends HfHubAccessor {
  constructor(account: HfAccountAccessor, config: HfRepoConfig) {
    super(account, config, 'model', VFSName.HF_MODELS)
  }
}

export class HfDatasetsAccessor extends HfHubAccessor {
  constructor(account: HfAccountAccessor, config: HfRepoConfig) {
    super(account, config, 'dataset', VFSName.HF_DATASETS)
  }
}

export class HfSpacesAccessor extends HfHubAccessor {
  constructor(account: HfAccountAccessor, config: HfRepoConfig) {
    super(account, config, 'space', VFSName.HF_SPACES)
  }
}
