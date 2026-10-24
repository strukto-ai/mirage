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
import { GSlidesAccessor } from '../../accessor/gslides.ts'

import { TokenManager } from '../../core/google/client.ts'

import { PROMPT, WRITE_PROMPT } from './prompt.ts'
import { type DirListing, VFSName } from '../../types.ts'

import { redactGSlidesConfig, type GSlidesConfig, type GSlidesConfigRedacted } from './config.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { SLIDES_WORDS } from '../../utils/generated/google_vocabulary.ts'
import { filesContaining as googleFilesContaining } from '../../core/google/search.ts'
import { MIME } from '../../core/gslides/constants.ts'
import { readdir as gslidesReaddir } from '../../core/gslides/readdir.ts'
import { read as gslidesRead } from '../../core/gslides/read.ts'
import { stat as gslidesStat } from '../../core/gslides/stat.ts'
import { appDeltaHook } from '../../core/google/events.ts'
import { makeFilename } from './slide_entry.ts'
import type { DeltaHook } from '../../events/base.ts'
import { unlink as gslidesUnlink } from '../../core/gslides/unlink.ts'
import { rename as gslidesRename } from '../../core/gslides/rename.ts'
import { WALK_LIMIT } from '../constants.ts'

export interface GSlidesVFSState {
  type: string
  config: GSlidesConfigRedacted
}

export class GSlidesVFS extends BaseVFS {
  override readonly name: string = VFSName.GSLIDES
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  // Reads stamp listing metadata; a fresh stat checks Drive by file ID.
  override readonly readRevalidatable: boolean = true
  override readonly prompt: string = PROMPT
  override readonly writePrompt: string = WRITE_PROMPT
  readonly config: GSlidesConfig
  override readonly accessor: GSlidesAccessor

  override readonly walkLimit: number

  constructor(config: GSlidesConfig) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    const tm = new TokenManager(config)
    this.accessor = new GSlidesAccessor({ tokenManager: tm })
  }

  override readonly handed = {
    unlink: ['entry'],
    rename: ['entry'],
  } as const

  override readonly renderers: Readonly<Record<string, string>> = { '.gslide.json': 'readDeck' }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord || this.walkLimit < 0) return Promise.resolve(null)
    return googleFilesContaining(this.accessor, gslidesReaddir, MIME, SLIDES_WORDS, text, [path])
  }

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return gslidesReaddir(this.accessor, path)
  }

  /** Render the file as the JSON its `.gslide.json` name holds. */
  async readDeck(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await gslidesRead(this.accessor, path)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return gslidesStat(this.accessor, path)
  }

  override unlink(path: PathSpec, handed?: Handed): Promise<void> {
    return gslidesUnlink(this.accessor, path, handed?.entry)
  }

  override rename(src: PathSpec, dst: PathSpec, handed?: Handed): Promise<void> {
    return gslidesRename(this.accessor, src, dst, handed?.entry ?? null)
  }

  override deltaHook(): DeltaHook {
    return appDeltaHook(this.accessor, MIME, makeFilename)
  }

  override getState(): Promise<GSlidesVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGSlidesConfig(this.config),
    })
  }
}
