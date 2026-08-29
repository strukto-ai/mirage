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

import { ChromaAccessor } from '../../accessor/chroma.ts'
import { CHROMA_COMMANDS } from '../../commands/builtin/chroma/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { readBytes } from '../../core/chroma/read.ts'
import { readdir as chromaReaddir } from '../../core/chroma/readdir.ts'
import { stat as chromaStat } from '../../core/chroma/stat.ts'
import { CHROMA_OPS } from '../../ops/chroma/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { ResourceName, type FileStat, type PathSpec } from '../../types.ts'
import { BaseResource, type Resource } from '../base.ts'
import {
  type ChromaConfigRedacted,
  redactChromaConfig,
  resolveChromaConfig,
  type ChromaConfig,
  type ChromaConfigResolved,
} from './config.ts'
import { CHROMA_PROMPT } from './prompt.ts'

const resolveGlob = makeResolveGlob(chromaReaddir)

export interface ChromaResourceOptions {
  config: ChromaConfig
}

export interface ChromaResourceState {
  type: string
  config: ChromaConfigRedacted
  needs_override: true
}

export class ChromaResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.CHROMA
  readonly cachesReads: boolean = false
  readonly supportsSnapshot: boolean = false
  // Every file is sized exactly, by one chunk scan per directory the caller
  // stats; the path tree's own size is the producer's source number and
  // never becomes the reported byte length.
  readonly sizesAlwaysKnown: boolean = true
  readonly prompt: string = CHROMA_PROMPT
  readonly config: ChromaConfigResolved
  readonly accessor: ChromaAccessor

  constructor(options: ChromaResourceOptions | ChromaConfig) {
    super()
    const config = 'config' in options ? options.config : options
    this.config = resolveChromaConfig(config)
    this.accessor = new ChromaAccessor(this.config)
  }

  override getState(): ChromaResourceState {
    return {
      type: this.kind,
      config: redactChromaConfig(this.config),
      // TypeScript cannot rebuild a config-backed mount from state:
      // `buildMountArgs` substitutes a RAMResource for anything it was
      // not handed. Saying so out loud turns a silently empty mount
      // into a refusal to load. Python reads the flag too now, and
      // writes it only where a rebuild really cannot work.
      needs_override: true,
    }
  }

  // Nothing to take back: the bytes live in the remote store, so a
  // restored mount reaches them through its config alone.
  override loadState(_state: ChromaResourceState): Promise<void> {
    return Promise.resolve()
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  ops(): readonly RegisteredOp[] {
    return CHROMA_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return CHROMA_COMMANDS
  }

  glob(paths: readonly PathSpec[], _prefix = ''): Promise<PathSpec[]> {
    return resolveGlob(this.accessor, paths, this.index)
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return readBytes(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return chromaReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return chromaStat(this.accessor, p, this.index)
  }
}
