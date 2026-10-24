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

import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'
import { LangfuseAccessor } from '../../accessor/langfuse.ts'

import { HttpLangfuseTransport } from '../../core/langfuse/client.ts'
import { type DirListing, VFSName } from '../../types.ts'

import { redactLangfuseConfig, type LangfuseConfig, type LangfuseConfigRedacted } from './config.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir as langfuseReaddir } from '../../core/langfuse/readdir.ts'
import { read as langfuseRead } from '../../core/langfuse/read.ts'
import { stat as langfuseStat } from '../../core/langfuse/stat.ts'
import { WALK_LIMIT } from '../constants.ts'

export const VFS_MD = `{prefix}
  traces/
    <trace-id>.json
  sessions/
    <session-id>/
      <trace-id>.json
  prompts/
    <prompt-name>/
      <version>.json
  datasets/
    <dataset-name>/
      items.jsonl
      runs/
        <run-name>.jsonl`

export interface LangfuseVFSState {
  type: string
  config: LangfuseConfigRedacted
}

export class LangfuseVFS extends BaseVFS {
  override readonly handed = {
    stat: ['entry'],
  } as const

  override readonly name: string = VFSName.LANGFUSE
  override readonly cachesReads: boolean = true
  override vfsMd: string = VFS_MD
  readonly config: LangfuseConfig
  override readonly accessor: LangfuseAccessor

  override readonly walkLimit: number
  constructor(config: LangfuseConfig) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    const transportOpts: { publicKey: string; secretKey: string; host?: string } = {
      publicKey: config.publicKey,
      secretKey: config.secretKey,
    }
    if (config.host !== undefined) transportOpts.host = config.host
    const accessorConfig: {
      defaultTraceLimit?: number
      defaultFromTimestamp?: string
    } = {}
    if (config.defaultTraceLimit !== undefined) {
      accessorConfig.defaultTraceLimit = config.defaultTraceLimit
    }
    if (config.defaultFromTimestamp !== undefined) {
      accessorConfig.defaultFromTimestamp = config.defaultFromTimestamp
    }
    this.accessor = new LangfuseAccessor(new HttpLangfuseTransport(transportOpts), accessorConfig)
  }

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return langfuseReaddir(this.accessor, path)
  }

  override async read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await langfuseRead(this.accessor, path)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return langfuseStat(this.accessor, path, handed?.entry)
  }

  override getState(): Promise<LangfuseVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactLangfuseConfig(this.config),
    })
  }
}
