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

import type { RegisteredCommand } from '../../commands/config.ts'
import {
  HttpNowledgeMemTransport,
  normalizeNowledgeMemConfig,
  nowledgeMemFind,
  nowledgeMemGrep,
  nowledgeMemPath,
  nowledgeMemRead,
  nowledgeMemReaddir,
  nowledgeMemRecall,
  nowledgeMemStat,
  redactNowledgeMemConfig,
  type NowledgeMemConfig,
  type NowledgeMemConfigRedacted,
} from '../../core/nowledge_mem/client.ts'
import { BaseResource, type Resource } from '../base.ts'
import { FileStat, PathSpec, ResourceName } from '../../types.ts'
import { NowledgeMemAccessor } from '../../accessor/nowledge_mem.ts'
import { NOWLEDGE_MEM_COMMANDS } from '../../commands/builtin/nowledge_mem/index.ts'
import { NOWLEDGE_MEM_PROMPT } from './prompt.ts'

export interface NowledgeMemResourceState {
  type: string
  config: NowledgeMemConfigRedacted
}

export class NowledgeMemResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.NOWLEDGE_MEM
  readonly isRemote: boolean = true
  readonly indexTtl: number = 60
  readonly prompt: string = NOWLEDGE_MEM_PROMPT
  readonly config: NowledgeMemConfig
  readonly accessor: NowledgeMemAccessor

  constructor(config: Record<string, unknown> | NowledgeMemConfig = {}) {
    super()
    this.config = normalizeNowledgeMemConfig(config as Record<string, unknown>)
    this.accessor = new NowledgeMemAccessor(
      new HttpNowledgeMemTransport(this.config),
      this.config.defaultLimit,
    )
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return NOWLEDGE_MEM_COMMANDS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return nowledgeMemRead(this.accessor, nowledgeMemPath(p.original, p.prefix))
  }

  readdir(p: PathSpec): Promise<string[]> {
    return nowledgeMemReaddir(this.accessor, nowledgeMemPath(p.original, p.prefix))
  }

  stat(p: PathSpec): Promise<FileStat> {
    return nowledgeMemStat(this.accessor, nowledgeMemPath(p.original, p.prefix))
  }

  find(p: PathSpec): Promise<string[]> {
    return nowledgeMemFind(this.accessor, nowledgeMemPath(p.original, p.prefix), {
      ...(this.config.defaultLimit !== undefined ? { limit: this.config.defaultLimit } : {}),
    })
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    return Promise.resolve(
      paths.map((p) =>
        p.prefix !== '' || prefix === ''
          ? p
          : new PathSpec({
              original: p.original,
              directory: p.directory,
              ...(p.pattern !== null ? { pattern: p.pattern } : {}),
              resolved: p.resolved,
              prefix,
            }),
      ),
    )
  }

  grep(path: string, query: string, limit?: number) {
    return nowledgeMemGrep(this.accessor, path, query, {
      ...(limit !== undefined
        ? { limit }
        : this.config.defaultLimit !== undefined
          ? { limit: this.config.defaultLimit }
          : {}),
    })
  }

  recall(query: string, path?: string, k?: number) {
    return nowledgeMemRecall(this.accessor, query, {
      ...(path !== undefined ? { path } : {}),
      ...(k !== undefined
        ? { k }
        : this.config.defaultLimit !== undefined
          ? { k: this.config.defaultLimit }
          : {}),
    })
  }

  getState(): Promise<NowledgeMemResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactNowledgeMemConfig(this.config),
    })
  }

  loadState(_state: NowledgeMemResourceState): Promise<void> {
    return Promise.resolve()
  }
}
