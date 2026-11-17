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

import type { CommandSpec, FlagValue } from '../../../commands/spec/types.ts'
import type { WordChoices } from '../../../commands/spec/word_choice.ts'
import type { ByteSource, IOResult } from '../../../io/types.ts'
import type { CommandWord, HandOff } from '../../../policy/types.ts'
import type { CallStack } from '../../../shell/call_stack.ts'
import type { JobConsole } from '../../../shell/console/index.ts'
import type { JobTable } from '../../../execution/job/index.ts'
import type { TSNodeLike } from '../../../shell/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { EvaluationContext } from '../../evaluation.ts'
import type { LineHandle } from '../../../execution/line/handle.ts'
import type { ExecutionNode } from '../../types.ts'

/**
 * One parsed command line, named field for field after Python's
 * `ParsedCommand` NamedTuple (executor/command/types.py). It replaces
 * a bare 15-slot positional tuple whose four identical `string[]`
 * slots could be swapped without a compile error, silently changing
 * which usage error is reported.
 */
export interface ParsedCommand {
  paths: PathSpec[]
  texts: string[]
  flagKwargs: Record<string, FlagValue>
  warnings: string[]
  invalidOptions: string[]
  ambiguousOptions: [string, readonly string[]][]
  optionErrorKinds: string[]
  needsValueOptions: string[]
  // The two wordings GNU picks between for a refused choice value, in scan
  // order: `invalid argument` for a value that matches no candidate,
  // `ambiguous argument` for one that prefixes candidates spanning two or
  // more values. optionErrorKinds orders them against each other and
  // against every other refusal on the line.
  invalidValueOptions: [string, string, WordChoices][]
  ambiguousValueOptions: [string, string, WordChoices][]
  invalidIntOptions: [string, string][]
  invalidFloatOptions: [string, string][]
  missingRequiredOptions: string[]
  oldOptionNeedsValue: string | null
  // Only a CLI reads these two: the display names of required operand
  // slots the line left empty, and the dests it actually typed in scan
  // order. Both feed a usage line rendered in another program's
  // dialect, which is why they carry names and order at all.
  missingRequiredOperands: readonly string[]
  typedDests: readonly string[]
  builtin: boolean
}

/** Per-call overrides a caller can layer onto the walker's deps. */
export interface ExecuteNodeOpts {
  /** @internal Scheduling scope; background jobs create their own. */
  lineHandle?: LineHandle
  sink?: JobConsole
  signal?: AbortSignal
  /** The hand-off the subtree runs on: a background job's own. */
  handed?: HandOff
  /**
   * The job list the subtree runs on: a background job's own, as bash's
   * forked job starts with none of its shell's, so a bare `wait` in it never
   * waits on itself.
   */
  jobTable?: JobTable
  /**
   * The node is the whole of a child shell (a background job), which runs
   * its EXIT action when the node ends.
   */
  endsShell?: boolean
  /**
   * False leaves what expanding the node printed to the caller, which
   * routes it around the node's redirects.
   */
  ownDiagnostics?: boolean
}

export type ExecuteNodeFn = (
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
) => Promise<[ByteSource | null, IOResult, ExecutionNode]>

/**
 * One command read once, as its grammar reads it: every view a policy gets
 * of the line comes from here. `words` holds one per word after the name, in
 * argv order, each with its kind, the option it belongs to and the path it
 * names; `supplied` the PATH option values no word typed, which a default
 * or the environment supplied; `tokens` the line as an admission pattern
 * reads it; `program` the name and a tree's verb path. Mirrors Python's
 * `LineReading`.
 */
export interface LineReading {
  readonly words: readonly CommandWord[]
  readonly supplied: readonly PathSpec[]
  readonly tokens: readonly string[]
  readonly program: readonly string[]
}

/**
 * How a CLI leaf's words are parsed, the one setting the run and a
 * policy's reading of the line share.
 *
 * spec: the grammar to parse with: the leaf, with the injected `--help`
 * or a script's pass-through rest. mirageHelp: whether the injected
 * `--help` is mirage's to answer. unknownIsOperand: whether an undeclared
 * dashed word is an operand; under the cobra dialect it is an error.
 * abbreviations: git's full long-option table for the verb, which
 * resolves an abbreviated long option; undefined for any other program.
 */
export interface LeafParse {
  readonly spec: CommandSpec
  readonly mirageHelp: boolean
  readonly unknownIsOperand: boolean
  readonly abbreviations: readonly string[] | undefined
}
