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

import type { TrelloAccessor } from '../../../accessor/trello.ts'
import { mountIo } from '../generic_bind/adapter.ts'
import { readStdinAsync } from '../utils/stream.ts'
import type { Context } from '../../config.ts'
import type { PathSpec } from '../../../types.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })

export interface ResolveTextInputOptions {
  inlineText: string | null
  filePath: PathSpec | null
  errorMessage: string
}

/**
 * A card's text from its flag, its `--*_file` operand, or stdin. The operand
 * is read through the mount's table, which hands the backend the rows a read
 * of it takes, as any read on the mount is. An empty inline text is the text
 * (`--desc ''` clears a description). Mirrors Python's `resolve_text_input`.
 */
export async function resolveTextInput(
  accessor: TrelloAccessor,
  command: Context,
  opts: ResolveTextInputOptions,
): Promise<string> {
  if (opts.inlineText !== null) return opts.inlineText
  if (opts.filePath !== null) {
    const data = await mountIo(command).readBytes(accessor, opts.filePath)
    return DEC.decode(data)
  }
  const raw = await readStdinAsync(command.stdin)
  if (raw !== null) return DEC.decode(raw)
  throw new Error(opts.errorMessage)
}
