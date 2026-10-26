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
import { type DirListing, VFSName } from '../../types.ts'

import {
  redactTrelloConfig,
  type TrelloConfig,
  type TrelloConfigRedacted,
} from '../../core/trello/config.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import { readdir as trelloReaddir } from '../../core/trello/readdir.ts'
import { read as trelloRead } from '../../core/trello/read.ts'
import { stat as trelloStat } from '../../core/trello/stat.ts'
import { filesContaining as trelloFilesContaining } from '../../core/trello/search.ts'

export const VFS_MD = `{prefix}
  workspaces/
    <workspace-name>__<workspace-id>/
      workspace.json
      boards/
        <board-name>__<board-id>/
          board.json
          members/
            <full-name>__<member-id>.json
          labels/
            <label-name>__<label-id>.json
          lists/
            <list-name>__<list-id>/
              list.json
              cards/
                <card-name>__<card-id>/
                  card.json
                  comments.jsonl
  Always ls directories first to discover exact names.

  To act on boards and cards (list boards, members, lists, labels,
  cards and comments; create, update, move, assign, label and comment
  on cards), use the trello CLI if installed: trello --help`

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
  override vfsMd: string = VFS_MD
  override readonly wholeWordSearch: boolean = true
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
    const transportOpts: {
      apiKey: string
      apiToken: string
      baseUrl?: string
      timeout?: number
    } = {
      apiKey: config.apiKey,
      apiToken: config.apiToken,
    }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    if (config.timeout !== undefined) transportOpts.timeout = config.timeout
    const accessorOpts: {
      workspaceId?: string
      boardIds?: readonly string[]
      capped: () => boolean
    } = { capped: () => this.walkLimit >= 0 }
    if (config.workspaceId !== undefined) accessorOpts.workspaceId = config.workspaceId
    if (config.boardIds !== undefined) accessorOpts.boardIds = config.boardIds
    this.accessor = new TrelloAccessor(new HttpTrelloTransport(transportOpts), accessorOpts)
  }

  /**
   * Whether this VFS answers `name`; with no walk limit it reads every
   * file rather than ask the service's search.
   */
  override supports(name: string): boolean {
    if (name === 'files_containing' && this.walkLimit < 0) return false
    return super.supports(name)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord || this.walkLimit < 0) return Promise.resolve(null)
    return trelloFilesContaining(this.accessor, text, [path])
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return trelloReaddir(this.accessor, path, handed?.entry)
  }

  override async read(path: PathSpec, handed?: Handed): Promise<Uint8Array> {
    return trelloRead(this.accessor, path, null, handed?.parent)
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
