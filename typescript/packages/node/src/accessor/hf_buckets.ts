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

import type { Operator } from 'opendal'
import { Accessor } from '@struktoai/mirage-core/accessor/index'
import { VFSName } from '@struktoai/mirage-core/types'
import * as kp from '@struktoai/mirage-core/utils/key_prefix'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import { loadOptionalPeer } from '../optional_peer.ts'
import { HF_ENDPOINT, type HfBucketsConfig } from '../vfs/hf_buckets/config.ts'
import { accountOf, type HfAccountAccessor } from './hf_hub.ts'

/**
 * A mount onto one Hugging Face bucket.
 *
 * Listing and writes go through the opendal operator; stat's point lookup and
 * every read go to the Hub through the account the mount builds, because the
 * bucket's content token (its xet hash) comes from paths-info and the resolve
 * download, neither of which the binding exposes.
 */
export class HfBucketsAccessor extends Accessor {
  readonly repoType: string = 'bucket'
  readonly vfsName: VFSName = VFSName.HF_BUCKETS
  private operatorPromise: Promise<Operator> | null = null

  readonly account: HfAccountAccessor

  constructor(public readonly config: HfBucketsConfig) {
    super()
    this.account = accountOf(config)
  }

  get repoId(): string {
    return this.config.bucket
  }

  get bucketUri(): string {
    return `hf://buckets/${this.repoId}`
  }

  get endpoint(): string {
    return this.config.endpoint ?? HF_ENDPOINT
  }

  get keyPrefix(): string {
    return kp.normalize(this.config.keyPrefix)
  }

  /**
   * Lift a mount-relative path to its bucket-relative spelling.
   *
   * opendal applies the key prefix as its operator root; a Hub call made
   * directly has to apply it here instead. Empty segments are dropped:
   * opendal normalizes its root the same way, and the Hub matches paths
   * exactly, so `a//b/x` would name a file the listing shows as `a/b/x` and
   * answer it absent.
   */
  bucketPath(rel: string): string {
    return `${this.keyPrefix}/${rel}`
      .split('/')
      .filter((part) => part !== '')
      .join('/')
  }

  operatorOptions(): Record<string, string> {
    const options: Record<string, string> = {
      repo_type: this.repoType,
      repo_id: this.repoId,
    }
    if (this.config.token !== undefined && this.config.token !== '') {
      options.token = this.config.token
    }
    if (this.config.endpoint !== undefined && this.config.endpoint !== '') {
      options.endpoint = this.config.endpoint
    }
    const keyPrefix = this.keyPrefix
    if (keyPrefix !== '') options.root = `/${stripSlash(keyPrefix)}/`
    return options
  }

  operator(): Promise<Operator> {
    this.operatorPromise ??= this.createOperator()
    return this.operatorPromise
  }

  private async createOperator(): Promise<Operator> {
    const mod = await loadOptionalPeer(
      () => import('opendal') as Promise<{ Operator: typeof Operator }>,
      { feature: 'HuggingFace VFS', packageName: 'opendal' },
    )
    return new mod.Operator('hf', this.operatorOptions())
  }
}
