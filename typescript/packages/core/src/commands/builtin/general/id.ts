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
import { quoteText } from '../../quote.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import {
  findUser,
  identityOf,
  ownAccount,
  sessionGid,
  sessionUid,
  type Account,
} from '../utils/identity.ts'

const ENC = new TextEncoder()

const CONTEXT = 'id: --context (-Z) works only on an SELinux-enabled kernel\n'
const ONE_CHOICE = 'id: cannot print "only" of more than one choice\n'
const NAMES_NEED = 'id: printing only names or real IDs requires -u, -g, or -G\n'
const ZERO_DEFAULT = 'id: option --zero not permitted in default format\n'

function named(number: number, name: string | null): string {
  return name === null ? String(number) : `${String(number)}(${name})`
}

// GNU `id` over the session's user database: root for a session with no
// profile, the profile's user (uid 1000) for a named one, and uid 1000 with
// no name for a document passed without one. Each user is in its own group
// alone; errors and their order are coreutils 9.7's.
function idCmd(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): CommandFnResult {
  const fl = new FlagView(ctx.flags, specOf('id'))
  if (fl.asBool('context'))
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(CONTEXT) })]
  const only = ['user', 'group', 'groups'].filter((dest) => fl.asBool(dest))
  if (only.length > 1) return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(ONE_CHOICE) })]
  const useName = fl.asBool('name')
  const zero = fl.asBool('zero')
  if (only.length === 0 && (useName || fl.asBool('real')))
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(NAMES_NEED) })]
  if (only.length === 0 && zero)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(ZERO_DEFAULT) })]
  const identity = identityOf(ctx)
  const end = zero ? '\0' : '\n'
  const out: string[] = []
  const err: string[] = []
  const rows: [number, string | null, number, string | null][] = []
  const names: (string | null)[] = texts.length > 0 ? texts : [null]
  for (const name of names) {
    let found: Account | null
    if (name === null) {
      found = ownAccount(identity)
      if (found === null) {
        rows.push([sessionUid(identity), null, sessionGid(identity), null])
        continue
      }
    } else {
      found = findUser(identity, name)
      if (found === null) {
        const why = name === '' ? ': No such file or directory' : ''
        err.push(`id: '${quoteText(name)}': no such user${why}\n`)
        continue
      }
    }
    rows.push([found.uid, found.name, found.gid, found.group])
  }
  const many = zero && only.length === 1 && only[0] === 'groups' && texts.length > 1
  for (const [uid, user, gid, group] of rows) {
    const choice = only[0]
    if (choice === undefined) {
      out.push(`uid=${named(uid, user)} gid=${named(gid, group)} groups=${named(gid, group)}${end}`)
      continue
    }
    const kind = choice === 'user' ? 'user' : 'group'
    const [number, label] = kind === 'user' ? [uid, user] : [gid, group]
    if (useName && label === null)
      err.push(`id: cannot find name for ${kind} ID ${String(number)}\n`)
    const shown = useName && label !== null ? label : String(number)
    out.push(shown + (many ? '\0\0' : end))
  }
  const body = out.join('')
  return [
    body === '' ? null : ENC.encode(body),
    new IOResult({ exitCode: err.length > 0 ? 1 : 0, stderr: ENC.encode(err.join('')) }),
  ]
}

export const GENERAL_ID = command({
  name: 'id',
  vfs: null,
  spec: specOf('id'),
  fn: idCmd,
})
