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
import { TrelloAccessor } from '../../accessor/trello.ts'

import { HttpTrelloTransport } from '../../core/trello/client.ts'

import { PROMPT, WRITE_PROMPT } from './prompt.ts'
import { type DirListing, VFSName } from '../../types.ts'

import {
  redactTrelloConfig,
  type TrelloConfig,
  type TrelloConfigRedacted,
} from '../../core/trello/config.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir as trelloReaddir } from '../../core/trello/readdir.ts'
import { read as trelloRead } from '../../core/trello/read.ts'
import { stat as trelloStat } from '../../core/trello/stat.ts'
import { filesContaining as trelloFilesContaining } from '../../core/trello/search.ts'

export interface TrelloVFSState {
  type: string
  config: TrelloConfigRedacted
}

export class TrelloVFS extends BaseVFS {
  override readonly handed = {
    readdir: ['entry'],
    read: ['parent'],
    stat: ['entry'],
  } as const

  override readonly name: string = VFSName.TRELLO
  override readonly cachesReads: boolean = true
  override readonly prompt: string = PROMPT
  override readonly writePrompt: string = WRITE_PROMPT
  readonly config: TrelloConfig
  override readonly accessor: TrelloAccessor
  // Trello's search answers for cards; comments and the board's other files
  // are always read.
  override readonly searchable: readonly string[] = [
    'workspaces/*/boards/*/lists/*/cards/*/card.json',
  ]

  constructor(config: TrelloConfig) {
    super()
    this.config = config
    const transportOpts: { apiKey: string; apiToken: string; baseUrl?: string } = {
      apiKey: config.apiKey,
      apiToken: config.apiToken,
    }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const accessorOpts: {
      workspaceId?: string
      boardIds?: readonly string[]
      contentSearch?: boolean
    } = {}
    if (config.workspaceId !== undefined) accessorOpts.workspaceId = config.workspaceId
    if (config.boardIds !== undefined) accessorOpts.boardIds = config.boardIds
    if (config.contentSearch !== undefined) accessorOpts.contentSearch = config.contentSearch
    this.accessor = new TrelloAccessor(new HttpTrelloTransport(transportOpts), accessorOpts)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord || this.config.contentSearch !== true) return Promise.resolve(null)
    return trelloFilesContaining(this.accessor, text, [path])
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return trelloReaddir(this.accessor, path, handed?.entry)
  }

  override async read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await trelloRead(this.accessor, path, null, handed?.parent)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return trelloStat(this.accessor, path, handed?.entry)
  }

  override getState(): Promise<TrelloVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactTrelloConfig(this.config),
    })
  }
}
