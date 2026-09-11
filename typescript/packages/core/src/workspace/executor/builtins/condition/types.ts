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

import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { Session } from '../../../session/session.ts'
import type { SessionView } from '../../../../ops/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'

export type CondNode =
  | { kind: 'word'; value: string }
  | { kind: 'unary'; op: string; operand: string }
  | { kind: 'binary'; left: string; op: string; right: string; rightLiteral: boolean }
  | { kind: 'not'; inner: CondNode }
  | { kind: 'and'; left: CondNode; right: CondNode }
  | { kind: 'or'; left: CondNode; right: CondNode }

/** A test/[/[[ usage error: bash prints the message and returns 2. */
/**
 * A test/[/[[ usage error: bash prints the message and returns 2. A `[[`
 * grammar error is a parse error that kills the line; an arithmetic error
 * inside a numeric operand (`[[ 0 -eq 1/0 ]]`) is not: bash prints it and
 * the test answers 1, the line going on, so it carries its own status and
 * is never fatal.
 */
export class CondError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2,
    readonly fatal = true,
  ) {
    super(message)
  }
}

export interface CondContext {
  dispatch: DispatchFn
  namespace: Namespace
  session: Session
  name: string
  // The session plane's gated door, which an assignment inside a numeric
  // operand lands through; absent outside a workspace.
  view?: SessionView
}
