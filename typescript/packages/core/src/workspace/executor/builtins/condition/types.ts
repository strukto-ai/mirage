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
import type { SessionState } from '../../../session/session.ts'
import type { LinkView, SessionView } from '../../../../view/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { EntryGate } from '../../../../policy/types.ts'
import type { Refusal } from '../../../../types.ts'
import { decodeText } from '../../../../shell/bytes.ts'

interface CondLazy {
  kind: 'lazy'
  expand: () => Promise<CondNode>
}

export type CondNode =
  | CondLazy
  | { kind: 'word'; value: string }
  | { kind: 'unary'; op: string; operand: string }
  | { kind: 'binary'; left: string; op: string; right: string; rightLiteral: boolean }
  | { kind: 'not'; inner: CondNode }
  | { kind: 'and'; left: CondNode; right: CondNode }
  | { kind: 'or'; left: CondNode; right: CondNode }

// test's own reading of a flat argv (`flatShape`): which words each
// operator takes, each named by its place in the argv, and where a grammar
// error stands, so it is raised where test's own parse meets it.

/** The word at `at`, true when it is not empty. */
export interface FlatString {
  kind: 'string'
  at: number
}

export interface FlatUnary {
  kind: 'unary'
  op: string
  at: number
}

export interface FlatBinary {
  kind: 'binary'
  left: number
  op: string
  right: number
}

export interface FlatNot {
  kind: 'not'
  inner: FlatNode
}

/** Terms joined by `-a`, a chain held flat so its length costs no depth. */
export interface FlatAnd {
  kind: 'and'
  terms: FlatNode[]
}

/** Terms joined by `-o`, held flat as `FlatAnd`'s are. */
export interface FlatOr {
  kind: 'or'
  terms: FlatNode[]
}

/** A grammar error, the test's whole answer once it is reached. */
export interface FlatFail {
  kind: 'fail'
  message: string
}

/** Null is the empty test, which is false. */
export type FlatNode =
  | FlatString
  | FlatUnary
  | FlatBinary
  | FlatNot
  | FlatAnd
  | FlatOr
  | FlatFail
  | null

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

/**
 * The gate refused a `[ ]` or a `[[ ]]` leaf: it answers that refusal, as
 * `test` refused whole does. `stderr` is the refusal's message,
 * newline-terminated; `exitCode` the status it answers with; `refusal` the
 * record the result carries.
 */
export class CondRefused extends Error {
  constructor(
    readonly stderr: Uint8Array,
    readonly exitCode: number,
    readonly refusal: Refusal | null,
  ) {
    super(decodeText(stderr))
  }
}

/**
 * Admits the words of a test as its own command, returning the gate its own
 * I/O runs under; throws `CondRefused`.
 */
export type AdmitTest = (words: string[]) => Promise<EntryGate>

export interface CondContext {
  dispatch: DispatchFn
  namespace: Namespace
  session: SessionState
  name: string
  // The gated session view, which an assignment inside a numeric
  // operand lands through; absent outside a workspace.
  view?: SessionView
  // The links as this session sees them: a hidden link is no link.
  links?: LinkView
  // Admits each `[[ ]]` leaf as it is evaluated, its branches expanding only
  // then; absent where the words were admitted whole before the test ran
  // (`test`, `[`).
  admit?: AdmitTest
  // The line's abort, which a long `=~` search stops at.
  signal?: AbortSignal
}
