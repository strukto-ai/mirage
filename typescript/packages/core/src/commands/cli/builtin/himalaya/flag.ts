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

import type { CommandFnResult, Context } from '../../../config.ts'
import type { PathSpec } from '../../../../types.ts'
import { FlagView } from '../../../spec/index.ts'
import { IOResult } from '../../../../io/types.ts'
import type { EmailAccessor } from '../../../../accessor/email.ts'
import { storeFlags, type FlagOp } from '../../../../core/email/client.ts'
import { rendered } from './printer.ts'

const IMAP_FLAGS: Record<string, string> = {
  seen: '\\Seen',
  answered: '\\Answered',
  flagged: '\\Flagged',
  draft: '\\Draft',
}
const VERBS: Record<FlagOp, string> = { add: 'added', set: 'set', remove: 'removed' }

async function store(
  accessor: EmailAccessor,
  texts: string[],
  ctx: Context,
  op: FlagOp,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const names = fl.asList('flag')
  await storeFlags(
    accessor,
    fl.asStr('mailbox', 'INBOX'),
    texts,
    names.map((name) => IMAP_FLAGS[name] ?? name),
    op,
  )
  const text = `Successfully ${VERBS[op]} flags: ${names.join(', ')}`
  return [rendered(fl, { flags: names }, text), new IOResult()]
}

export async function flagAdd(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  return store(accessor, texts, ctx, 'add')
}

export async function flagSet(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  return store(accessor, texts, ctx, 'set')
}

export async function flagRemove(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  return store(accessor, texts, ctx, 'remove')
}
