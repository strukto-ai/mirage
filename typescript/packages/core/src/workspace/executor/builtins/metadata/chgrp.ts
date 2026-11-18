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

import { groupId, type Identity } from '../../../../commands/builtin/utils/identity.ts'
import { missingOperandError } from '../../../../commands/spec/usage.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { FileStat, type PathSpec } from '../../../../types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { SessionState } from '../../../session/session.ts'
import { fail, parseLine } from '../shared.ts'
import { changeOwner, parseGroup, referenceOperands, referenceStat } from './metadata.ts'

// chgrp GROUP FILE...: set group ownership via setattr. The group half of
// chown: writes gid and leaves uid untouched. The group is stored as an id,
// not enforced: a name the session's user database holds is its id, any
// number is one, and a name it lacks is refused. `-h` writes the link node's
// own group, and --reference copies a file's group, the session's for a file
// that reports none.
export async function handleChgrp(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: SessionState,
  args: readonly (string | PathSpec)[],
): Promise<RedirectResult> {
  const [parsed, fl, refused] = parseLine('chgrp', args, session.cwd)
  if (refused !== null) return refused
  const identity: Identity = { profile: session.profile ?? null }
  const reference = fl.asPath('reference')
  if (reference !== undefined) {
    const operands = referenceOperands(parsed.texts, parsed.paths, session.cwd)
    if (operands.length === 0) {
      const error = missingOperandError('chgrp', null)
      return fail('chgrp', `${error.message}\n`, error.exitCode)
    }
    const found = await referenceStat(namespace.sessionLinks(session), dispatch, 'chgrp', reference)
    if (!(found instanceof FileStat)) return found
    return changeOwner(
      namespace,
      dispatch,
      session,
      'chgrp',
      fl,
      operands,
      null,
      groupId(found.gid, identity),
    )
  }
  const groupText = parsed.texts[0]
  if (groupText === undefined || parsed.paths.length === 0) {
    const error = missingOperandError('chgrp', groupText ?? null)
    return fail('chgrp', `${error.message}\n`, error.exitCode)
  }
  const gid = parseGroup(groupText, identity)
  if (gid === null) {
    return fail('chgrp', `chgrp: invalid group: '${groupText}'\n`, 1)
  }
  return changeOwner(namespace, dispatch, session, 'chgrp', fl, parsed.paths, null, gid, null, [
    null,
    groupText,
  ])
}
