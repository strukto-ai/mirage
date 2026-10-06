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

import { applyOpLimit } from '../commands/builtin/utils/limit.ts'
import type { Decisions } from '../policy/decisions.ts'
import type { Policies } from '../policy/policies.ts'
import { postVfsGate, preVfsGate } from '../policy/policies.ts'
import type { MountMode, PathSpec } from '../types.ts'

/** The POSIX policy boundary for dispatched filesystem operations: the
 * ordered builtin and user policies, the owning mount prefix, its
 * configured mode (the authorization ceiling), the session whose grants
 * govern the op, and the approval ledger a path rule that asks is put to
 * where no line is running. Mirrors Python's OpBoundary. */
export class OpBoundary {
  constructor(
    readonly policies: Policies,
    readonly prefix = '',
    readonly mode?: MountMode | undefined,
    readonly sessionId = '',
    readonly decisions: Decisions | null = null,
  ) {}

  async admit(
    op: string,
    path: PathSpec,
    write: boolean,
    access: { create?: boolean; subtree?: boolean; checkHidden?: boolean; final?: boolean } = {},
    issuer?: symbol,
  ): Promise<void> {
    await preVfsGate(this.policies, op, path, write, this.prefix, this.sessionId, issuer, {
      ...(this.mode === undefined ? {} : { mode: this.mode }),
      decisions: this.decisions,
      ...access,
    })
  }

  async complete(op: string, path: PathSpec, write: boolean, result: unknown): Promise<unknown> {
    return applyOpLimit(
      result,
      await postVfsGate(this.policies, op, path, write, this.prefix, result),
    )
  }
}
