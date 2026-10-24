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

import { TrelloAccessor } from '../../../../accessor/trello.ts'
import { HttpTrelloTransport } from '../../../../core/trello/client.ts'
import type { TrelloConfig } from '../../../../core/trello/config.ts'
import type { PathSpec } from '../../../../types.ts'
import type { Context } from '../../../config.ts'
import type { FlagView } from '../../../spec/flag_view.ts'
import { readStdinAsync } from '../../../builtin/utils/stream.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })

/** The install's accessor, built once from its validated config. */
export function trelloAccessor(config: unknown): TrelloAccessor {
  const cfg = config as TrelloConfig
  const transport = new HttpTrelloTransport({
    apiKey: cfg.apiKey,
    apiToken: cfg.apiToken,
    ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
  })
  return new TrelloAccessor(transport, {
    ...(cfg.workspaceId !== undefined ? { workspaceId: cfg.workspaceId } : {}),
    ...(cfg.boardIds !== undefined ? { boardIds: cfg.boardIds } : {}),
  })
}

/** The path a `--*_file` flag names, or null when absent. */
export function fileOperand(fl: FlagView, name: string): PathSpec | null {
  return fl.asPath(name) ?? null
}

/** A flag the verb cannot run without, refused when absent or empty. */
export function requiredFlag(fl: FlagView, name: string): string {
  const value = fl.asStr(name)
  if (value === undefined || value === '') throw new Error(`--${name} is required`)
  return value
}

export interface ResolveTextInputOptions {
  value: string
  file: string
  errorMessage: string
}

/**
 * A card's text from its flag, its `--*_file` operand, or stdin. The operand
 * is a workspace file the line names, read through `ctx.vfs` as any CLI reads
 * one: it may sit on any mount the session can read, and no mount is the
 * CLI's account. An empty inline text is the text (`--desc ''` clears a
 * description). Mirrors Python's `resolve_text_input`.
 */
export async function resolveTextInput(
  ctx: Context,
  fl: FlagView,
  opts: ResolveTextInputOptions,
): Promise<string> {
  const inline = fl.asStr(opts.value)
  if (inline !== undefined) return inline
  const path = fileOperand(fl, opts.file)
  if (path !== null) {
    if (ctx.vfs === undefined) {
      throw new Error(`--${opts.file} needs a workspace to read files from`)
    }
    return DEC.decode(await ctx.vfs.read(path))
  }
  const raw = await readStdinAsync(ctx.stdin)
  if (raw !== null) return DEC.decode(raw)
  throw new Error(opts.errorMessage)
}
