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

import type { RedirectResult } from '../../../context/session_context.ts'
import type { JobTable } from '../../../execution/job/index.ts'
import type { JobConsole } from '../../../shell/console/index.ts'
import type { SessionView } from '../../../view/types.ts'
import type { Argv } from '../../expand/argv.ts'
import type { CliTarget, ExternalTarget, FunctionTarget } from '../../lookup/types.ts'
import type { SessionState } from '../../session/session.ts'
import type { BuiltinFn } from '../builtins/types.ts'

export type CommandWorker = (
  jobs: JobTable,
  words: string[],
  session: SessionState,
  view: SessionView,
  signal?: AbortSignal,
  sink?: JobConsole,
) => RedirectResult | Promise<RedirectResult>

export interface WorkerTarget {
  readonly kind: 'worker'
  readonly handler: CommandWorker
}

export interface PathTarget {
  readonly kind: 'path'
  readonly fallback: ExternalTarget | null
}

export interface MountTarget {
  readonly kind: 'mount'
  readonly wrapper: readonly [string, string] | null
}

export type HandlerTarget =
  | FunctionTarget
  | CliTarget
  | WorkerTarget
  | MountTarget
  | { readonly kind: 'unknown' }

export const NamespaceProgram = Object.freeze({
  LN: 'ln',
  READLINK: 'readlink',
  GETFATTR: 'getfattr',
  SETFATTR: 'setfattr',
  CHMOD: 'chmod',
  CHOWN: 'chown',
  CHGRP: 'chgrp',
  TOUCH: 'touch',
  DF: 'df',
  MOUNT: 'mount',
} as const)

export type NamespaceProgram = (typeof NamespaceProgram)[keyof typeof NamespaceProgram]

export const NAMESPACE_PROGRAMS: ReadonlyMap<string, NamespaceProgram> = new Map(
  Object.values(NamespaceProgram).map((op) => [op, op]),
)

export type ExecutionTarget =
  | HandlerTarget
  | ExternalTarget
  | PathTarget
  | { readonly kind: 'wrapper' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'result'; readonly result: RedirectResult }
  | { readonly kind: 'builtin'; readonly handler: BuiltinFn }
  | { readonly kind: 'namespace'; readonly operation: NamespaceProgram }

/** An admitted argv and its next action under the command's placement. */
export type ResolvedCommand<T extends ExecutionTarget = ExecutionTarget> = Readonly<{
  argv: Argv
  target: T
}>
