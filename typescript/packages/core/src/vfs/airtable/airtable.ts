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

import { AirtableAccessor } from '../../accessor/airtable.ts'
import { AIRTABLE_COMMANDS } from '../../commands/builtin/airtable/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import {
  redactAirtableConfig,
  type AirtableConfig,
  type AirtableConfigRedacted,
} from '../../core/airtable/config.ts'
import { AIRTABLE_OPS } from '../../ops/airtable/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { VFSName } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import { PROMPT, WRITE_PROMPT } from './prompt.ts'

export interface AirtableVFSState {
  type: string
  config: AirtableConfigRedacted
}

/**
 * Airtable bases as directories, tables as records.jsonl files. Records are
 * live data another client may edit at any moment, so reads are never served
 * from the file cache; the schema listings still ride the index for its TTL.
 * The transport is plain fetch, so one class serves node and the browser.
 */
export class AirtableVFS extends BaseVFS {
  override readonly name: string = VFSName.AIRTABLE
  override readonly cachesReads: boolean = false
  // records.jsonl and the view files render a paged read, so their size is
  // unknown until the bytes exist.
  override readonly sizesAlwaysKnown: boolean = false
  override readonly supportsSnapshot: boolean = false
  override readonly prompt: string = PROMPT
  override readonly writePrompt: string = WRITE_PROMPT
  override readonly accessor: AirtableAccessor

  private readonly config: AirtableConfig

  constructor(config: AirtableConfig, options: { fetchFn?: typeof fetch } = {}) {
    super()
    this.config = config
    this.accessor = new AirtableAccessor(config, options)
  }

  override commands(): readonly RegisteredCommand[] {
    return AIRTABLE_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return AIRTABLE_OPS
  }

  override getState(): AirtableVFSState {
    return { type: this.name, config: redactAirtableConfig(this.config) }
  }
}
