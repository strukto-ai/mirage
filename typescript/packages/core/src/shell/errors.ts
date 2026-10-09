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

export { PipeClosed } from '../io/errors.ts'

import type { ByteSource } from '../io/types.ts'
import type { ArithWrite } from './types.ts'
import { encodeText } from './bytes.ts'
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

// A bash arithmetic syntax or evaluation error. Mirrors Python's
// mirage.shell.errors.ArithError.
/**
 * A bash arithmetic syntax or evaluation error. `writes` carries the
 * assignments the expression made before it failed: bash binds each at
 * once, so `x=5, 1/0` leaves `x` at 5 and `RANDOM=42, RANDOM + 1/0`
 * leaves the generator seeded and drawn from. The evaluator fills it as
 * it throws; a caller lands them the way it lands a successful result's,
 * then reports the error.
 */
export class ArithError extends Error {
  writes: ArithWrite[] = []
}

/**
 * An arithmetic assignment to a readonly shell variable. The evaluation
 * stops at it, as bash's does: `writes` carries the assignments made before
 * it, which bind (`(( X=5, R=3 ))` leaves X at 5), and nothing after it
 * runs. `inSubscript` marks one made while an array subscript evaluated
 * (`${a[R=3]}`, `(( a[R=3] ))`), which ends the shell wherever the
 * subscript is. Mirrors Python's mirage.shell.errors.ReadonlyError.
 */
export class ReadonlyError extends Error {
  readonly varName: string
  readonly inSubscript: boolean
  writes: ArithWrite[] = []

  constructor(name: string, inSubscript = false) {
    super(`${name}: readonly variable`)
    this.name = 'ReadonlyError'
    this.varName = name
    this.inSubscript = inSubscript
  }

  /**
   * How the error unwinds where no status answers it: one in a subscript,
   * or in an `-i` value (`fatal`), ends the shell with 1; any other
   * discards the line, as `$((R=3))` does.
   */
  signal(fatal = false): ExitSignal {
    const stderr = encodeText(`bash: ${this.message}\n`)
    if (fatal || this.inSubscript) return new ExitSignal(1, stderr, null, 1)
    return new DiscardSignal(stderr)
  }
}

// A fatal shell exit request unwinding the current execution. Raised by
// the `exit` builtin and by fatal expansion errors (`${var:?msg}`), which
// bash treats as an implicit `exit 1` in a non-interactive shell.
// Contained at subshell, pipeline-segment, and background-job boundaries;
// the top-level program loop stops the remaining statements. Mirrors
// Python's mirage.shell.errors.ExitSignal.
export class ExitSignal extends Error {
  exitCode: number
  stderr: Uint8Array
  stdout: Uint8Array | null
  // Status a containing boundary reports instead of exitCode. GNU bash
  // exits 127 on a fatal expansion error but a subshell wrapping one
  // returns 1; `exit N` uses N in both positions (the default).
  containedCode: number
  // The id of the command whose own words were being expanded when it was
  // raised. bash expands a simple command's words before it applies the
  // command's redirects, so that diagnostic goes around them; any other
  // goes through the redirects it was written under.
  expanding: number | null = null
  // The program an `exec` replaced the shell with, whose actions went with
  // it.
  replaced: string | null = null
  // Whether stdout is a nested line's (an `exec`'d program's, or an ERR or
  // RETURN action's that left), which the redirects the signal unwinds
  // through still route. An EXIT action's output goes around those
  // redirects, as bash runs it once the shell has unwound.
  unrouted = false
  // That EXIT output, the end of stdout.
  cleanup: Uint8Array = new Uint8Array()
  // Whether it was raised in text `eval` or `source` ran: a forked stage or
  // job reports its contained status even for a simple command
  // (`eval ': ${U?}' | cat` is 1, `: ${U?} | cat` 127).
  sourced = false

  constructor(
    exitCode = 0,
    stderr: Uint8Array = new Uint8Array(),
    stdout: Uint8Array | null = null,
    containedCode: number | null = null,
  ) {
    super('exit')
    this.name = 'ExitSignal'
    this.exitCode = exitCode
    this.stderr = stderr
    this.stdout = stdout
    this.containedCode = containedCode ?? exitCode
  }
}

/**
 * An error after which bash discards the rest of the line. A bad
 * substitution, an arithmetic or assignment error, a write the shell refuses:
 * the command never runs, and neither do the statements after it on its line,
 * but the next line does, with `$?` at 1. The line loop of a shell, of `eval`
 * and of `source` resumes there; a child shell ends on it with status 1, and
 * so does `set -e`. `containedCode` is the status a `( )` subshell, or a
 * compound command forked as a stage or job, ends with when the error
 * reaches it rather than a line loop: 2 for a refused `${var:=word}`, 1 for
 * any other. Mirrors Python's mirage.shell.errors.DiscardSignal.
 */
export class DiscardSignal extends ExitSignal {
  constructor(stderr: Uint8Array = new Uint8Array(), containedCode = 1) {
    super(1, stderr, null, containedCode)
    this.name = 'DiscardSignal'
  }
}

/**
 * `set -u` reading a name that is not set: `$x`, `${a[i]}`, or a variable
 * an arithmetic expression reads. GNU bash dies on it the way it dies on
 * `${x:?}`: status 127 at top level, 1 from a containing subshell or
 * pipeline segment. Mirrors Python's mirage.shell.errors.UnboundVariable.
 */
export class UnboundVariable extends ExitSignal {
  constructor(name: string) {
    super(127, encodeText(`bash: ${name}: unbound variable\n`), null, 1)
    this.name = 'UnboundVariable'
  }
}

/**
 * A `${...}` bash cannot read, found as its word expands. bash names the text
 * of the expansion it was running: the whole word, a double-quoted part's
 * inside, an operator's word, an arithmetic expression, a heredoc's body.
 * Each level the error leaves renames it (`within`) until one of those fixes
 * the name. Mirrors Python's mirage.shell.errors.BadSubstitution.
 */
export class BadSubstitution extends DiscardSignal {
  private fixed = false

  constructor(text: string) {
    super()
    this.name = 'BadSubstitution'
    this.within(text)
  }

  /** Name the word being expanded, unless a boundary already has. */
  within(word: string, fixed = false): this {
    if (!this.fixed) {
      this.stderr = encodeText(`bash: ${word}: bad substitution\n`)
      this.fixed = fixed
    }
    return this
  }
}

/**
 * Await an expansion of `word`, which a bad substitution names: a
 * double-quoted part's inside, an operator's word, an arithmetic expression.
 * Mirrors Python's mirage.shell.errors.named.
 */
export async function named<T>(word: string, pending: Promise<T>): Promise<T> {
  try {
    return await pending
  } catch (err) {
    if (err instanceof BadSubstitution) throw err.within(word, true)
    throw err
  }
}

/**
 * `return` unwinding to the function or sourced file it ends; `stdout` is the
 * output the constructs it left had produced before it.
 */
export class ReturnSignal extends Error {
  readonly exitCode: number
  stderr: Uint8Array
  stdout: ByteSource | null
  // Whether stdout is an ERR or RETURN action's that left with `return`,
  // which the redirects it unwinds through still route, as
  // `ExitSignal.unrouted` does.
  unrouted = false
  constructor(
    exitCode: number,
    stderr: Uint8Array = new Uint8Array(),
    stdout: ByteSource | null = null,
  ) {
    super('return')
    this.name = 'ReturnSignal'
    this.exitCode = exitCode
    this.stderr = stderr
    this.stdout = stdout
  }
}
