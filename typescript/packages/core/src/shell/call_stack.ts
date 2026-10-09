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

export interface CallFrameInit {
  positional?: string[]
  locals?: Record<string, string>
  functionName?: string
  loopLevel?: number
  sourced?: boolean
  closed?: boolean
}

export class CallFrame {
  positional: string[]
  locals: Record<string, string>
  functionName: string
  loopLevel: number
  sourced: boolean
  // A sourced file whose RETURN action runs: it has returned.
  closed: boolean

  constructor(init: CallFrameInit = {}) {
    this.positional = init.positional ?? []
    this.locals = init.locals ?? {}
    this.functionName = init.functionName ?? ''
    this.loopLevel = init.loopLevel ?? 0
    this.sourced = init.sourced ?? false
    this.closed = init.closed ?? false
  }
}

export class CallStack {
  private readonly frames: CallFrame[] = [new CallFrame()]
  // A fork is a child shell's stack: an error that discards the rest of
  // the line ends the child instead of resuming.
  subshell = false
  // A `( )` subshell, a compound command forked as a stage or job, or a
  // fork of one: a refused `${var:=word}` ends it with 2.
  paren = false

  /**
   * The stack a child shell runs on, a copy of every frame. `loops` keeps
   * the loops the caller is in, as a pipeline stage and `$( )` do; a `( )`
   * or `&` child starts outside every loop (bash 5.2, POSIX interp 842).
   * `paren` is true for a child running a `( )` or a compound command,
   * false for a substitution, and null keeps the caller's.
   */
  fork(loops = true, paren: boolean | null = null): CallStack {
    const child = new CallStack()
    child.frames.splice(
      0,
      child.frames.length,
      ...this.frames.map(
        (frame) =>
          new CallFrame({
            positional: [...frame.positional],
            locals: { ...frame.locals },
            functionName: frame.functionName,
            loopLevel: loops ? frame.loopLevel : 0,
            sourced: frame.sourced,
            closed: frame.closed,
          }),
      ),
    )
    child.subshell = true
    child.paren = paren ?? this.paren
    return child
  }

  get current(): CallFrame {
    const frame = this.frames[this.frames.length - 1]
    if (frame === undefined) throw new Error('call stack is empty')
    return frame
  }

  /**
   * Enter a function, or a sourced file (`functionName` is `source`). A
   * function starts outside every loop, so `break` in it cannot end its
   * caller's; a sourced file runs in its caller's loops.
   */
  push(positional: string[] = [], functionName = '', sourced = false): void {
    this.frames.push(
      new CallFrame({
        positional,
        functionName,
        loopLevel: sourced ? this.current.loopLevel : 0,
        sourced,
      }),
    )
  }

  pop(): CallFrame {
    if (this.frames.length <= 1) return this.current
    const popped = this.frames.pop()
    if (popped === undefined) throw new Error('pop on empty stack')
    return popped
  }

  get depth(): number {
    return this.frames.length
  }

  /** Whether a function or sourced file is running for `return` to leave. */
  get returnable(): boolean {
    return this.frames.slice(1).some((frame) => !frame.closed)
  }

  /** Count a loop the current frame runs, for `break` and `continue`. */
  async loop<T>(run: () => Promise<T>): Promise<T> {
    const frame = this.current
    frame.loopLevel++
    try {
      return await run()
    } finally {
      frame.loopLevel--
    }
  }

  /**
   * `${FUNCNAME[@]}`: the frames innermost first, a sourced file as
   * `source`. Empty while no function runs, as bash hides a sourced file's
   * entry outside one, and one whose RETURN action runs: it has returned.
   */
  functionNames(): readonly string[] {
    const frames = this.frames.slice(1).filter((frame) => !frame.closed)
    if (frames.every((frame) => frame.sourced)) return []
    return frames.reverse().map((frame) => frame.functionName)
  }

  getAllPositional(): string[] {
    return this.current.positional
  }

  setPositional(values: string[]): void {
    this.current.positional = values
  }

  setLocal(name: string, value: string): void {
    this.current.locals[name] = value
  }

  getLocal(name: string): string | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i]
      if (frame !== undefined && Object.hasOwn(frame.locals, name)) {
        return frame.locals[name] ?? null
      }
    }
    return null
  }
}
