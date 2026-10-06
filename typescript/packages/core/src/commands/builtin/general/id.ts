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
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { quoteText } from '../../quote.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { UNKNOWN_NAME, identityOf } from '../utils/identity.ts'

const ENC = new TextEncoder()

const CONTEXT = 'id: --context (-Z) works only on an SELinux-enabled kernel\n'
const ONE_CHOICE = 'id: cannot print "only" of more than one choice\n'
const NAMES_NEED = 'id: printing only names or real IDs requires -u, -g, or -G\n'
const ZERO_DEFAULT = 'id: option --zero not permitted in default format\n'

// GNU `id` over mirage's identity: the workspace user, and the session's
// profile as its group. Mirage has names but no numbers, so every id slot holds
// the name, `-` for a part nobody claimed; errors and their order are coreutils
// 9.7's.
function idCmd(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): CommandFnResult {
  const fl = new FlagView(opts.flags, specOf('id'))
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
  const identity = identityOf(opts)
  const user = identity.user ?? UNKNOWN_NAME
  const group = identity.profile ?? UNKNOWN_NAME
  const end = zero ? '\0' : '\n'
  const out: string[] = []
  const err: string[] = []
  const names: (string | null)[] = texts.length > 0 ? texts : [null]
  for (const name of names) {
    if (name !== null && name !== identity.user) {
      const why = name === '' ? ': No such file or directory' : ''
      err.push(`id: '${quoteText(name)}': no such user${why}\n`)
      continue
    }
    const choice = only[0]
    if (choice === undefined) {
      out.push(`uid=${user} gid=${group} groups=${group}${end}`)
      continue
    }
    const kind = choice === 'user' ? 'user' : 'group'
    const known = kind === 'user' ? identity.user : identity.profile
    if (useName && known === null) err.push(`id: cannot find name for ${kind} ID\n`)
    const many = zero && choice === 'groups' && texts.length > 1
    out.push((kind === 'user' ? user : group) + (many ? '\0\0' : end))
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
