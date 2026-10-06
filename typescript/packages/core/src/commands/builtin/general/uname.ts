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
import { specOf } from '../../spec/builtins.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { HOSTNAME } from './hostname.ts'

const ENC = new TextEncoder()

// What uname reports, in GNU's print order and keyed by each option's dest.
// Mirage is no kernel: it answers as the GNU/Linux userland its commands
// implement, the way gVisor and WSL1 answer `Linux` for the interface they
// emulate, and names itself in the node, release and version fields. Fixed,
// so every host (the browser included) prints the same line and no host
// detail leaks.
const UNAME_FIELDS: readonly (readonly [string, string])[] = [
  ['kernel_name', 'Linux'],
  ['nodename', HOSTNAME],
  ['kernel_release', 'mirage'],
  ['kernel_version', '#1 Mirage'],
  ['machine', 'x86_64'],
  ['processor', 'unknown'],
  ['hardware_platform', 'unknown'],
  ['operating_system', 'GNU/Linux'],
]
const UNKNOWN = 'unknown'

// GNU `uname`: one field per option, in GNU's order, never the order typed.
// No option is `-s`. `-a` prints every field except an `unknown` processor or
// hardware platform, which only `-p` and `-i` without `-a` print, as GNU
// does. Pinned against coreutils 9.7.
function uname(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): CommandFnResult {
  const fl = new FlagView(opts.flags, specOf('uname'))
  const extra = texts[0]
  if (extra !== undefined) throw extraOperandError(CommandName.UNAME, extra)
  const chosen = fl.asBool('all')
    ? UNAME_FIELDS.filter(([, value]) => value !== UNKNOWN).map(([, value]) => value)
    : UNAME_FIELDS.filter(([dest]) => fl.asBool(dest)).map(([, value]) => value)
  if (chosen.length === 0) chosen.push(UNAME_FIELDS[0]?.[1] ?? '')
  return [ENC.encode(chosen.join(' ') + '\n'), new IOResult()]
}

export const GENERAL_UNAME = command({
  name: 'uname',
  vfs: null,
  spec: specOf('uname'),
  fn: uname,
})
