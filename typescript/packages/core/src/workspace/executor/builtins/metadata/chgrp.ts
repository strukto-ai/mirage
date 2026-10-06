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

import type { PathSpec } from '../../../../types.ts'
import { missingOperandError } from '../../../../commands/spec/usage.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { SessionState } from '../../../session/session.ts'
import { fail, parseLine } from '../shared.ts'
import { changeOwner, parseGroup } from './metadata.ts'
import type { Result } from '../types.ts'

// chgrp GROUP FILE...: set group ownership via setattr. The group half of
// chown: writes gid and leaves uid untouched. Group is stored, not enforced
// (mirage has no group model); a name is kept verbatim, a numeric id becomes
// a number. `-h` writes the link node's own group.
export async function handleChgrp(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: SessionState,
  args: readonly (string | PathSpec)[],
): Promise<Result> {
  const [parsed, fl, refused] = parseLine('chgrp', args, session.cwd)
  if (refused !== null) return refused
  const groupText = parsed.texts[0]
  if (groupText === undefined || parsed.paths.length === 0) {
    const error = missingOperandError('chgrp', groupText ?? null)
    return fail('chgrp', `${error.message}\n`, error.exitCode)
  }
  const gid = parseGroup(groupText)
  if (gid === null) {
    return fail('chgrp', `chgrp: invalid group: '${groupText}'\n`, 1)
  }
  return changeOwner(namespace, dispatch, session, 'chgrp', fl, parsed.paths, null, gid)
}
