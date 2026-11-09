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
import { copyMessages, moveMessages } from '../../../../core/email/client.ts'
import { notice } from './printer.ts'

function report(fl: FlagView, count: number, verb: string): Uint8Array {
  const text =
    count === 0
      ? `No message ${verb}: no id matched in the source mailbox`
      : count === 1
        ? `1 message successfully ${verb}`
        : `${String(count)} messages successfully ${verb}`
  return notice(fl, text)
}

export async function messageCopy(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const count = await copyMessages(accessor, fl.asStr('from', 'INBOX'), fl.asStr('to') ?? '', texts)
  return [report(fl, count, 'copied'), new IOResult()]
}

export async function messageMove(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const count = await moveMessages(accessor, fl.asStr('from', 'INBOX'), fl.asStr('to') ?? '', texts)
  return [report(fl, count, 'moved'), new IOResult()]
}
