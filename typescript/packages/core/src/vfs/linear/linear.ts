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
import { LinearAccessor } from '../../accessor/linear.ts'

import { filesContaining as linearFilesContaining } from '../../core/linear/search.ts'
import { HttpLinearTransport } from '../../core/linear/client.ts'
import { redactLinearConfig } from '../../core/linear/config.ts'
import type { LinearConfig, LinearConfigRedacted } from '../../core/linear/config.ts'

import { PROMPT, WRITE_PROMPT } from './prompt.ts'
import { type DirListing, VFSName } from '../../types.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir as linearReaddir } from '../../core/linear/readdir.ts'
import { read as linearRead } from '../../core/linear/read.ts'
import { stat as linearStat } from '../../core/linear/stat.ts'
import { FULL_SCAN_LIMIT } from '../constants.ts'

export interface LinearVFSState {
  type: string
  config: LinearConfigRedacted
}

export class LinearVFS extends BaseVFS {
  override readonly handed = {
    readdir: ['entry'],
    read: ['parent'],
    stat: ['entry'],
  } as const

  override readonly name: string = VFSName.LINEAR
  override readonly cachesReads: boolean = true
  // Every file is sized at its parent's readdir from the listing payload
  // (comments.jsonl via one bounded comments call), so stat always reports
  // the rendered byte length and fskit mounts serve exact reads.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly prompt: string = PROMPT
  override readonly writePrompt: string = WRITE_PROMPT
  readonly config: LinearConfig
  override readonly accessor: LinearAccessor
  // Linear's search answers for issues; comments and the team's other files
  // are always read.
  override readonly searchable: readonly string[] = [
    'teams/*/issues/*/issue.json',
    'teams/*/members/*',
    'teams/*/projects/*',
    'teams/*/cycles/*',
    'teams/*/documents/*',
  ]

  override readonly fullScanLimit: number

  constructor(config: LinearConfig) {
    super()
    this.config = config
    this.fullScanLimit = config.fullScanLimit ?? FULL_SCAN_LIMIT
    const transportOpts: { apiKey: string; baseUrl?: string } = { apiKey: config.apiKey }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const accessorOpts: { teamIds?: readonly string[]; fullScanLimit?: number } = {}
    if (config.teamIds !== undefined) accessorOpts.teamIds = config.teamIds
    accessorOpts.fullScanLimit = this.fullScanLimit
    this.accessor = new LinearAccessor(new HttpLinearTransport(transportOpts), accessorOpts)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    return linearFilesContaining(
      this.accessor,
      text,
      [path],
      opts.wholeWord && this.fullScanLimit >= 0,
    )
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return linearReaddir(this.accessor, path, handed?.entry)
  }

  override async read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await linearRead(this.accessor, path, null, handed?.parent)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return linearStat(this.accessor, path, handed?.entry)
  }

  override getState(): Promise<LinearVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactLinearConfig(this.config),
    })
  }
}
