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

import type { DiscordAccessor } from '../../../accessor/discord.ts'
import type { IndexCacheStore } from '../../../cache/index/index.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { DISCORD_IO } from './io.ts'
import { read as discordRead } from '../../../core/discord/read.ts'
import { stat as discordStat } from '../../../core/discord/stat.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { headGeneric } from '../generic/head.ts'
import { fileReadProvision } from './_provision.ts'

const resolveDiscordGlob = resolveGlobOf(DISCORD_IO)

async function* discordStream(
  accessor: DiscordAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
): AsyncIterable<Uint8Array> {
  yield await discordRead(accessor, p, index)
}

async function headCommand(
  accessor: DiscordAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveDiscordGlob(accessor, paths, opts.index ?? undefined) : []
  return headGeneric(
    resolved,
    texts,
    opts,
    (p) => discordStat(accessor, p, opts.index ?? undefined),
    (p) => discordStream(accessor, p, opts.index ?? undefined),
  )
}

export const DISCORD_HEAD = command({
  name: 'head',
  resource: ResourceName.DISCORD,
  spec: specOf('head'),
  fn: headCommand,
  provision: fileReadProvision,
})
