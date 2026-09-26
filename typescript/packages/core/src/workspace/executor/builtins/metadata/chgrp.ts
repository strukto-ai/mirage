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

import type { FileStat } from '../../../../types.ts'
import { PathSpec } from '../../../../types.ts'
import { fsStrerror, isEnoent, isEnotdir } from '../../../../utils/errors.ts'
import { CycleError } from '../../../../utils/path.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import { expandOperands, fail, finish, splitValueFlags } from '../shared.ts'
import {
  isReadOnlyError,
  permissionError,
  parseGroup,
  setattrLink,
  setattrVia,
  walkOwned,
} from './metadata.ts'
import type { Result } from '../types.ts'

// chgrp GROUP FILE...: set group ownership via setattr. The group half of
// chown: writes gid and leaves uid untouched. Group is stored, not enforced
// (mirage has no group model); a name is kept verbatim, a numeric id becomes
// a number. `-h` writes the link node's own group.
export async function handleChgrp(
  namespace: Namespace,
  dispatch: DispatchFn,
  args: readonly (string | PathSpec)[],
): Promise<Result> {
  const { flags, operands, bad } = splitValueFlags(args, 'Rvfh', '')
  if (bad !== null) return fail('chgrp', `chgrp: invalid option -- '${bad}'\n`, 2)
  if (operands.length < 2) return fail('chgrp', 'chgrp: missing operand\n', 2)
  const first = operands[0]
  if (first === undefined) return fail('chgrp', 'chgrp: missing operand\n', 2)
  const groupText = first instanceof PathSpec ? first.virtual : first
  const gid = parseGroup(groupText)
  if (gid === null) {
    return fail('chgrp', `chgrp: invalid group: '${groupText}'\n`, 1)
  }

  const recursive = flags.has('R')
  const noDeref = recursive || flags.has('h')
  const errors: string[] = []
  for (const target of await expandOperands(namespace, operands.slice(1))) {
    if (noDeref && namespace.isLink(target.virtual)) {
      await setattrLink(dispatch, target, { gid })
      continue
    }
    let virtual: string
    try {
      virtual = namespace.follow(target.virtual)
    } catch (err) {
      if (err instanceof CycleError) {
        errors.push(`chgrp: cannot access '${target.rawPath}': Too many levels of symbolic links\n`)
        continue
      }
      throw err
    }
    const resolved = PathSpec.fromStrPath(virtual)
    let stat: FileStat
    try {
      const [result] = await dispatch('stat', resolved)
      stat = result as FileStat
    } catch (err) {
      const strerror = isEnoent(err) || isEnotdir(err) ? fsStrerror(err) : null
      if (strerror !== null) {
        errors.push(`chgrp: cannot access '${target.rawPath}': ${strerror}\n`)
        continue
      }
      throw err
    }
    const { paths, links } = recursive
      ? await walkOwned(namespace, dispatch, resolved, stat)
      : { paths: [resolved], links: [] as string[] }
    for (const path of paths) {
      try {
        await setattrVia(dispatch, path, { gid })
      } catch (err) {
        if (!isReadOnlyError(err)) throw err
        errors.push(permissionError('chgrp', 'changing group of', path, err))
      }
    }
    for (const link of links) {
      await setattrLink(dispatch, PathSpec.fromStrPath(link), { gid })
    }
  }
  return finish('chgrp', errors)
}
