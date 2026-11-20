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

import type { Runtime } from '../../runtime/base.ts'
import type { CLIInstall } from '../cli/types.ts'
import type { FunctionSite } from '../session/functions.ts'

/**
 * The layer that consumes a command: a command belongs to the layer
 * whose state it mutates.
 *
 * The verdict drives both the dispatch branch and the word policy:
 * SESSION / NAMESPACE / FUNCTION words are shell-resolved (bash
 * contract: programs receive matches, never patterns); MOUNT words
 * keep glob patterns intact for backend pushdown; UNKNOWN words are
 * never resolved (the command fails, backend I/O for it is waste).
 */
export const Consumer = Object.freeze({
  SESSION: 'session',
  NAMESPACE: 'namespace',
  FUNCTION: 'function',
  CLI: 'cli',
  MOUNT: 'mount',
  EXTERNAL: 'external',
  UNKNOWN: 'unknown',
} as const)

export type Consumer = (typeof Consumer)[keyof typeof Consumer]

export interface ExternalTarget {
  readonly kind: typeof Consumer.EXTERNAL
  readonly runtime: Runtime | null
}

export interface FunctionTarget {
  readonly kind: typeof Consumer.FUNCTION
  readonly body: string
  readonly site: FunctionSite | null
}

export interface CliTarget {
  readonly kind: typeof Consumer.CLI
  readonly install: CLIInstall
}

export type CommandTarget =
  | ExternalTarget
  | FunctionTarget
  | CliTarget
  | {
      readonly kind:
        | typeof Consumer.SESSION
        | typeof Consumer.NAMESPACE
        | typeof Consumer.MOUNT
        | typeof Consumer.UNKNOWN
    }

// CLI rides with the shell consumers for word policy: an installed CLI
// is a program, and bash hands programs glob matches, never patterns.
export const SHELL_CONSUMERS: ReadonlySet<Consumer> = new Set([
  Consumer.SESSION,
  Consumer.NAMESPACE,
  Consumer.FUNCTION,
  Consumer.CLI,
  Consumer.EXTERNAL,
])

/**
 * How a command's words are resolved, derived from its consumer.
 *
 * SHELL: the shell resolves globs before the command runs and spec
 * hints are ignored; bash expands `echo /data/*.txt` no matter what
 * echo does with its arguments. NAMESPACE and FUNCTION consumers get
 * the same treatment (programs receive matches, never patterns).
 *
 * MOUNT: the command's spec classifies words (TEXT stays literal,
 * PATH resolves) and glob PathSpecs stay intact for backend pushdown.
 * UNKNOWN names also land here: nothing resolves their words, the
 * command fails before any backend I/O.
 */
export const WordPolicy = Object.freeze({
  SHELL: 'shell',
  MOUNT: 'mount',
} as const)

export type WordPolicy = (typeof WordPolicy)[keyof typeof WordPolicy]

/** Map a consumer to its word policy. */
export function wordPolicy(consumer: Consumer): WordPolicy {
  return SHELL_CONSUMERS.has(consumer) ? WordPolicy.SHELL : WordPolicy.MOUNT
}

/** A program-running wrapper's option grammar and its answers. Mirrors Python's `WrapperOptions`. */
export interface WrapperOptions {
  /** Options that take a value. */
  readonly values: readonly string[]
  /** Options that take none. */
  readonly flags: readonly string[]
  /** Options after which it runs no program. */
  readonly stops: readonly string[]
  /** Its exit status for a bad option. */
  readonly status: number
  /** Its stderr for a program it cannot run, `{}` the program's name. */
  readonly missing: string
}

/** What a wrapper with no program for Mirage to run comes to. Mirrors
 * Python's `WrapperAnswer`. */
export class WrapperAnswer {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly runsFrom: number | null

  constructor(
    init: { exitCode?: number; stdout?: string; stderr?: string; runsFrom?: number | null } = {},
  ) {
    this.exitCode = init.exitCode ?? 0
    this.stdout = init.stdout ?? ''
    this.stderr = init.stderr ?? ''
    this.runsFrom = init.runsFrom ?? null
  }
}

/**
 * What a command asks about a program it names: `PROGRAM_LOOKUPS` marks
 * each command and option that asks one.
 *
 * PATH prints the program's file (`which perl`, `type -P perl`,
 * `command -v perl`). KIND says what the name is (`type perl`,
 * `type -t perl`, `command -V perl`). EXISTS checks that the program can
 * run before running it, so a missing one gets the command's own error
 * (`timeout 5 perl`, `xargs perl`, `exec perl`).
 *
 * Whatever would run the name on the line answers. Mirage answers a name
 * it runs itself (`grep`, a CLI, a builtin, a function), with its file
 * under `/usr/bin`. Any other name is asked of the one machine that would
 * run it: a machine that takes the name by name, else the first that
 * takes `@external`, as the line places it. That machine runs the command
 * the agent typed (`which perl`; a `type` or `command` in its bash, whose
 * builtins they are) and its answer is printed. With no machine to run
 * the name, it is not found and no machine is asked. A path the machine
 * prints is kept where Mirage shows that same path as that machine's own
 * file; any other becomes the name's `/usr/bin` file, which runs the name
 * on that machine all the same, so `$(which NAME)` runs what `NAME` runs.
 */
export const ProgramLookup = Object.freeze({
  PATH: 'path',
  KIND: 'kind',
  EXISTS: 'exists',
} as const)

export type ProgramLookup = (typeof ProgramLookup)[keyof typeof ProgramLookup]

/** What the machine that runs a name answered a lookup of it. Mirrors
 * Python's `MachineAnswer`. */
export class MachineAnswer {
  /** The machine found the name. */
  readonly found: boolean
  /** What it printed, a line each, with a path Mirage does not show at
   * that same path already turned into the name's `/usr/bin` file. */
  readonly lines: readonly string[]

  constructor(found: boolean, lines: readonly string[] = []) {
    this.found = found
    this.lines = lines
  }
}
