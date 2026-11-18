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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { quoteText } from '../../quote.ts'
import { identityOf, ownAccount, sessionGid, userNamed } from '../utils/identity.ts'

const ENC = new TextEncoder()

// Each user's groups, as `id -Gn` names them: every user is in its own group
// alone. With no operand, the session's, by number where the user database
// holds no name for it.
function groups(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): CommandFnResult {
  const identity = identityOf(ctx)
  if (texts.length === 0) {
    const own = ownAccount(identity)
    if (own !== null) return [ENC.encode(`${own.group}\n`), new IOResult()]
    const gid = String(sessionGid(identity))
    return [
      ENC.encode(`${gid}\n`),
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode(`groups: cannot find name for group ID ${gid}\n`),
      }),
    ]
  }
  const out: string[] = []
  const err: string[] = []
  for (const name of texts) {
    const found = userNamed(identity, name)
    if (found === null) err.push(`groups: '${quoteText(name)}': no such user\n`)
    else out.push(`${name} : ${found.group}\n`)
  }
  return [
    out.length > 0 ? ENC.encode(out.join('')) : null,
    new IOResult({
      exitCode: err.length > 0 ? 1 : 0,
      ...(err.length > 0 ? { stderr: ENC.encode(err.join('')) } : {}),
    }),
  ]
}

export const GENERAL_GROUPS = command({
  name: 'groups',
  vfs: null,
  spec: specOf('groups'),
  fn: groups,
})
