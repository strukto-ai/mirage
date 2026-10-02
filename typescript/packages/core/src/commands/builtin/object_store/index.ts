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

import type { Accessor } from '../../../accessor/base.ts'
import type { CommandOpts, RegisteredCommand } from '../../config.ts'
import type { CommandIO } from '../generic_bind/index.ts'
import { withPathGuards, withPolicyGuard, withSettledWrites } from '../generic_bind/adapter.ts'
import { withProbeAnswers, withSlashGuard } from '../generic_bind/factory.ts'
import { makeMkdir } from './mkdir.ts'
import { makeRm } from './rm.ts'
import { makeStat } from './stat.ts'
import { makeTee } from './tee.ts'
import { makeTouch } from './touch.ts'

// Keyed-store behaviours kept as overrides of the generic commands: no
// real directories (mkdir -p, rm not-empty), write-tracking (touch/tee),
// and the index-threaded, missing-operand stat.
export const OBJECT_STORE_OVERRIDES = new Set(['stat', 'rm', 'mkdir', 'tee', 'touch'])

/**
 * Build the five keyed-store command overrides for one backend.
 *
 * The op table is wrapped with the same hidden/rule/mode chain the
 * factory gives every generic command, the policy guard outermost as
 * there, so an override enforces the session's path axis and the coded
 * op policies exactly like the generic it replaces. `stat` also reuses the
 * running command's probe answer (withProbeAnswers), applied to the raw table
 * below every guard, as the factory applies it.
 *
 * @param vfs VFS name the commands register under
 * @param io the backend's op table; must wire the write-side slots the
 *   overrides consume
 */
export function makeObjectStoreCommands<A extends Accessor>(
  vfs: string,
  rawIo: CommandIO<A>,
): RegisteredCommand[] {
  const guarded = withPolicyGuard(withSlashGuard(withPathGuards(rawIo)))
  const answered = withPolicyGuard(withSlashGuard(withPathGuards(withProbeAnswers(rawIo))))
  // The overrides that write bind their chain per invocation, as the
  // factory binds every generic's, so their writes settle in the attr
  // overlay through the invocation's namespace door, innermost. rm's
  // overlay goes with the shell's rm, which drops what it removed.
  const settledFor = (opts: CommandOpts): CommandIO<A> =>
    withPolicyGuard(withSlashGuard(withPathGuards(withSettledWrites(rawIo, opts.ns?.settleWrite))))
  return [
    ...makeMkdir(vfs, settledFor),
    ...makeRm(vfs, guarded),
    ...makeStat(vfs, answered),
    ...makeTee(vfs, settledFor),
    ...makeTouch(vfs, settledFor),
  ]
}
