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

import type { SessionAccess } from '../view/types.ts'
import { limitResult } from '../commands/builtin/utils/limit.ts'
import type { Decisions } from './decisions.ts'
import type { Policies } from './policies.ts'
import { postVfsGate, preVfsGate } from './policies.ts'
import type { MountMode, PathSpec } from '../types.ts'
import type { VfsCall } from '../vfs/types.ts'

/** The POSIX policy boundary for dispatched filesystem operations: the
 * ordered builtin and user policies, the owning mount prefix, its
 * configured mode (the authorization ceiling), the session whose grants
 * govern the op, and the approval ledger a path rule that asks is put to
 * where no line is running. Mirrors Python's Boundary. */
export class Boundary {
  constructor(
    readonly policies: Policies,
    readonly prefix = '',
    readonly mode?: MountMode | undefined,
    readonly sessionId = '',
    readonly decisions: Decisions | null = null,
    readonly access?: SessionAccess,
  ) {}

  async admit(
    call: VfsCall,
    path: PathSpec,
    write: boolean,
    access: { checkHidden?: boolean; final?: boolean } = {},
    issuer?: symbol,
  ): Promise<void> {
    await preVfsGate(this.policies, call, path, write, this.prefix, this.sessionId, issuer, {
      ...(this.mode === undefined ? {} : { mode: this.mode }),
      decisions: this.decisions,
      ...(this.access === undefined ? {} : { access: this.access }),
      ...access,
    })
  }

  async complete(call: VfsCall, path: PathSpec, write: boolean, result: unknown): Promise<unknown> {
    return limitResult(
      result,
      await postVfsGate(this.policies, call, path, write, this.prefix, result, this.sessionId, {
        ...(this.mode === undefined ? {} : { mode: this.mode }),
        decisions: this.decisions,
        ...(this.access === undefined ? {} : { access: this.access }),
      }),
    )
  }
}
