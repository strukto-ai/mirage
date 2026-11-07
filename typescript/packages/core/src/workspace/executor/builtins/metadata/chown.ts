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

import { missingOperandError } from '../../../../commands/spec/usage.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { FileStat, type PathSpec } from '../../../../types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { SessionState } from '../../../session/session.ts'
import { fail, parseLine } from '../shared.ts'
import { changeOwner, parseOwner, referenceOperands, referenceStat } from './metadata.ts'

// chown OWNER[:GROUP] FILE...: set ownership via setattr. Ownership is
// stored, not enforced (mirage has no user model); names are kept
// verbatim, numeric ids become numbers. --reference copies a file's owner
// and group, and --from changes only a file that has the owner and group it
// names.
export async function handleChown(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: SessionState,
  args: readonly (string | PathSpec)[],
): Promise<RedirectResult> {
  const [parsed, fl, refused] = parseLine('chown', args, session.cwd)
  if (refused !== null) return refused
  const fromText = fl.asStr('from')
  const current = fromText === undefined ? null : parseOwner(fromText)
  const reference = fl.asPath('reference')
  if (reference !== undefined) {
    const operands = referenceOperands(parsed.texts, parsed.paths, session.cwd)
    if (operands.length === 0) {
      const error = missingOperandError('chown', null)
      return fail('chown', `${error.message}\n`, error.exitCode)
    }
    const found = await referenceStat(namespace.sessionLinks(session), dispatch, 'chown', reference)
    if (!(found instanceof FileStat)) return found
    return changeOwner(
      namespace,
      dispatch,
      session,
      'chown',
      fl,
      operands,
      found.uid,
      found.gid,
      current,
    )
  }
  const ownerText = parsed.texts[0]
  if (ownerText === undefined || parsed.paths.length === 0) {
    const error = missingOperandError('chown', ownerText ?? null)
    return fail('chown', `${error.message}\n`, error.exitCode)
  }
  const [uid, gid] = parseOwner(ownerText)
  if (uid === null && gid === null) {
    return fail('chown', `chown: invalid spec: '${ownerText}'\n`, 1)
  }
  return changeOwner(namespace, dispatch, session, 'chown', fl, parsed.paths, uid, gid, current)
}
