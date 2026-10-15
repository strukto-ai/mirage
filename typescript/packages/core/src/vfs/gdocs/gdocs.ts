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
import { GDocsAccessor } from '../../accessor/gdocs.ts'

import { TokenManager } from '../../core/google/client.ts'

import { PROMPT, WRITE_PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import { redactGDocsConfig, type GDocsConfig, type GDocsConfigRedacted } from './config.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { DOCS_WORDS } from '../../utils/generated/google_vocabulary.ts'
import { filesContaining as googleFilesContaining } from '../../core/google/search.ts'
import { MIME } from '../../core/gdocs/constants.ts'
import { readdir as gdocsReaddir } from '../../core/gdocs/readdir.ts'
import { read as gdocsRead } from '../../core/gdocs/read.ts'
import { stat as gdocsStat } from '../../core/gdocs/stat.ts'
import { appDeltaHook } from '../../core/google/watch.ts'
import { makeFilename } from './doc_entry.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { unlink as gdocsUnlink } from '../../core/gdocs/unlink.ts'
import { rename as gdocsRename } from '../../core/gdocs/rename.ts'

export interface GDocsVFSState {
  type: string
  config: GDocsConfigRedacted
}

export class GDocsVFS extends BaseVFS {
  override readonly name: string = VFSName.GDOCS
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  // Reads stamp listing metadata; a fresh stat checks Drive by file ID.
  override readonly readRevalidatable: boolean = true
  override readonly prompt: string = PROMPT
  override readonly writePrompt: string = WRITE_PROMPT
  readonly config: GDocsConfig
  override readonly accessor: GDocsAccessor

  constructor(config: GDocsConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GDocsAccessor({ tokenManager: tm })
  }

  override readonly renderers: Readonly<Record<string, string>> = { '.gdoc.json': 'readDoc' }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
    index?: IndexCacheStore,
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord || this.config.contentSearch !== true) return Promise.resolve(null)
    return googleFilesContaining(this.accessor, gdocsReaddir, MIME, DOCS_WORDS, text, [path], index)
  }

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return gdocsReaddir(this.accessor, path, index)
  }

  /** Render the file as the JSON its `.gdoc.json` name holds. */
  async readDoc(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await gdocsRead(this.accessor, path, index)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return gdocsStat(this.accessor, path, index)
  }

  override unlink(path: PathSpec, index?: IndexCacheStore): Promise<void> {
    return gdocsUnlink(this.accessor, path, index)
  }

  override rename(src: PathSpec, dst: PathSpec, index?: IndexCacheStore): Promise<void> {
    return gdocsRename(this.accessor, src, dst, index)
  }

  override deltaHook(): DeltaHook {
    return appDeltaHook(this.accessor, MIME, makeFilename)
  }

  override getState(): Promise<GDocsVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGDocsConfig(this.config),
    })
  }
}
