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

import { FlagView } from '../../../spec/types.ts'
import { getSelf } from '../../../../core/notion/pages.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import { notionTransport, prettyJson } from './util.ts'

const ENC = new TextEncoder()

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function strOf(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

// Nine columns, pinned against the upstream binary: identity, then the
// workspace the token belongs to, then the bot's owner. A bot owned by the
// workspace repeats the workspace in the owner columns because that is
// literally who owns it; a bot owned by a user names that user, and their
// email is the fourth column, the same slot a person's own email occupies.
export function whoamiRow(me: Record<string, unknown>): ByteSource {
  const bot = asObject(me.bot)
  const owner = asObject(bot.owner)
  const user = asObject(owner.user)
  const workspaceId = strOf(bot, 'workspace_id')
  const workspaceName = strOf(bot, 'workspace_name')
  const hasBot = Object.keys(bot).length > 0
  const byUser = owner.type === 'user'
  const email = byUser ? strOf(asObject(user.person), 'email') : strOf(asObject(me.person), 'email')
  const ownerId = byUser ? strOf(user, 'id') : workspaceId
  const ownerName = byUser ? strOf(user, 'name') : workspaceName
  // The last column is the owner's own kind, so a user owner reports what
  // that user is (`person`), not the `user` discriminator on the envelope.
  const ownerType = byUser ? strOf(user, 'type') : strOf(owner, 'type')
  const columns = [
    strOf(me, 'id'),
    strOf(me, 'name'),
    strOf(me, 'type'),
    email,
    workspaceId,
    workspaceName,
    hasBot ? ownerId : '',
    hasBot ? ownerName : '',
    ownerType,
  ]
  return ENC.encode(`${columns.join('\t')}\n`)
}

export async function whoami(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const me = await getSelf(notionTransport(inv.config, inv.flags))
  if (fl.asBool('json')) return [prettyJson(me), new IOResult()]
  return [whoamiRow(me), new IOResult()]
}
