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
import { loadOptionalPeer } from '../optional_peer.ts'
import type { HfBucketsConfig, HfRepoConfig } from '../vfs/hf_buckets/config.ts'

export const HF_VFS_NAMES = [
  VFSName.HF_BUCKETS,
  VFSName.HF_DATASETS,
  VFSName.HF_MODELS,
  VFSName.HF_SPACES,
] as const

export abstract class HfAccessor extends Accessor {
  abstract readonly repoType: string
  abstract readonly vfsName: VFSName
  private operatorPromise: Promise<Operator> | null = null

  constructor(public readonly config: HfBucketsConfig | HfRepoConfig) {
    super()
  }

  get repoId(): string {
    const config = this.config as { bucket?: string; repoId?: string }
    return config.repoId ?? config.bucket ?? ''
  }

  abstract get bucketUri(): string

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
    const keyPrefix = this.config.keyPrefix
    if (keyPrefix !== undefined && keyPrefix !== '') {
      options.root = `/${stripSlashes(keyPrefix)}/`
    }
    const revision = (this.config as { revision?: string }).revision
    if (revision !== undefined && revision !== '') {
      options.revision = revision
    }
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

function stripSlashes(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '/') start += 1
  while (end > start && value[end - 1] === '/') end -= 1
  return value.slice(start, end)
}

export class HfBucketsAccessor extends HfAccessor {
  readonly repoType: string = 'bucket'
  readonly vfsName: VFSName = VFSName.HF_BUCKETS

  get bucketUri(): string {
    return `hf://buckets/${this.repoId}`
  }
}

export class HfDatasetsAccessor extends HfAccessor {
  readonly repoType: string = 'dataset'
  readonly vfsName: VFSName = VFSName.HF_DATASETS

  get bucketUri(): string {
    return `hf://datasets/${this.repoId}`
  }
}

export class HfModelsAccessor extends HfAccessor {
  readonly repoType: string = 'model'
  readonly vfsName: VFSName = VFSName.HF_MODELS

  get bucketUri(): string {
    return `hf://models/${this.repoId}`
  }
}

export class HfSpacesAccessor extends HfAccessor {
  readonly repoType: string = 'space'
  readonly vfsName: VFSName = VFSName.HF_SPACES

  get bucketUri(): string {
    return `hf://spaces/${this.repoId}`
  }
}
