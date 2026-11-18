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

import type { MachineAccessor } from '../../accessor/machine.ts'
import type { PathSpec, SetAttrFields } from '../../types.ts'
import { singleQuote } from '../../utils/quote.ts'
import { checked, remote } from './utils.ts'

/**
 * An owner or group as the machine's chown reads it: a number takes a `+`,
 * which skips the name lookup, so a numeric account name on the machine cannot
 * take it; a name stays as given.
 */
function idSpec(id: number | string): string {
  return typeof id === 'number' ? `+${String(id)}` : id
}

/**
 * The line that sets a file's mode, owners and times on a machine, null
 * when nothing is asked.
 *
 * @param target the file's path on the machine.
 * @param fields the mode, owners and ISO times asked for.
 */
export function attrsCommand(target: string, fields: SetAttrFields): string | null {
  const q = singleQuote(target)
  const steps: string[] = []
  if (fields.mode !== undefined) steps.push(`chmod ${fields.mode.toString(8)} -- ${q}`)
  if (fields.uid !== undefined) {
    const owner =
      fields.gid === undefined ? idSpec(fields.uid) : `${idSpec(fields.uid)}:${idSpec(fields.gid)}`
    steps.push(`chown ${singleQuote(owner)} -- ${q}`)
  } else if (fields.gid !== undefined) {
    steps.push(`chgrp ${singleQuote(idSpec(fields.gid))} -- ${q}`)
  }
  for (const [flag, when] of [
    ['-a', fields.atime],
    ['-m', fields.mtime],
  ] as const) {
    if (when !== undefined)
      steps.push(`touch -c ${flag} -d @${String(Date.parse(when) / 1000)} -- ${q}`)
  }
  return steps.length === 0 ? null : steps.join(' && ')
}

/**
 * Set a file's metadata on its machine, all of it there: a machine's own
 * programs read the same file, so nothing is left to an overlay.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the file.
 * @param fields the mode, owners and ISO times asked for.
 * @returns the fields the file does not hold, none.
 */
export async function setAttrs(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  fields: SetAttrFields,
): Promise<Record<string, number | string>> {
  const command = attrsCommand(remote(accessor, path), fields)
  if (command !== null) await checked(accessor, machine, command, path)
  return {}
}
