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

import { IOResult } from '../../io/types.ts'
import type { Observer } from '../../observe/observer.ts'
import type { OpRecord } from '../../observe/record.ts'
import type { JobConsole } from '../../shell/console/job_console.ts'
import { Terminal } from '../../shell/console/index.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { concat } from '../../utils/bytes.ts'
import type { SessionState } from '../session/session.ts'
import { historyEntries } from './entries.ts'
import type { HistoryEntry } from './types.ts'

declare module '../../context/session_context.ts' {
  interface Caller {
    // The typed line whose root program records its history a command
    // read at a time.
    readonly history: LineHistory | null
  }
}

/**
 * A typed line's history, recorded as bash's line reader adds it: an entry
 * per command the line reads, each with what it wrote to the terminal and
 * the status it left, where a line of one command is recorded whole. The
 * line's root program reaches each command as it runs it (`reach`), and
 * the line's end ends the last (`end`). A line answered before its tree
 * runs, or run whole on a runtime (`typed`), is recorded once, as typed.
 * Input the root reads again (`readOn`) goes on with the root it is read
 * as. Mirrors Python's LineHistory.
 */
export class LineHistory {
  private shift = 0
  private next: number | null = null
  private current = -1
  private opened = 0
  private line: string | undefined
  private ops = 0
  private whole = false
  private through = false
  private done = false

  private constructor(
    private readonly observer: Observer,
    private readonly command: string,
    private root: TSNodeLike,
    private readonly entries: readonly HistoryEntry[],
    private readonly sessionId: string,
    private readonly session: SessionState,
    private readonly id: string | undefined,
    private readonly terminal: Terminal,
  ) {}

  /**
   * The history of a line whose input bash's reader reads as more than
   * one entry, written to a terminal; null for any other line, which the
   * line records whole as it starts.
   *
   * @param observer the workspace's observer.
   * @param command the line as typed.
   * @param root the parsed line.
   * @param sessionId the session the line is recorded under.
   * @param session the session the line runs on, whose cwd its entries name.
   * @param id the line's execution id, its first entry's.
   * @param sink where the line writes.
   */
  static open(
    observer: Observer,
    command: string,
    root: TSNodeLike,
    sessionId: string,
    session: SessionState,
    id: string | undefined,
    sink: JobConsole | undefined,
  ): LineHistory | null {
    if (!(sink instanceof Terminal)) return null
    const entries = historyEntries(root)
    if (entries.length < 2) return null
    return new LineHistory(observer, command, root, entries, sessionId, session, id, sink)
  }

  /**
   * Whether `node`'s program reads the line: the line's root, or the first
   * root to run once its input is read again (`readOn`), which takes over.
   *
   * @param node a program about to run its statements.
   */
  reads(node: TSNodeLike): boolean {
    if (node === this.root) return true
    if (this.next === null || (node.parent ?? null) !== null) return false
    this.root = node
    this.shift = this.next
    this.next = null
    return true
  }

  /**
   * Read the root's input again from a statement on, as a root of its own
   * that `run` parses and runs.
   *
   * @param at where, in the root's input, the input read again starts:
   *   the statement's index less the blank rows put ahead of it.
   * @param run reads it.
   */
  async readOn(at: number, run: () => Promise<IOResult>): Promise<IOResult> {
    this.next = this.shift + at
    try {
      return await run()
    } finally {
      this.next = null
    }
  }

  /**
   * Reach the command the root program runs next: end the entry before it
   * and record the entries up to it, its own last.
   *
   * @param child the root's statement about to run.
   * @param session the shell running it, whose `$?` ends the entry before.
   * @param records the line's op records so far, of which the entry
   *   before's are those since the one before it ended.
   */
  async reach(
    child: TSNodeLike,
    session: SessionState,
    records: readonly OpRecord[],
  ): Promise<void> {
    if (this.whole || this.done) return
    const start = child.startIndex ?? 0
    const at = this.shift + (this.root.offsets?.[start] ?? start)
    let reached = this.current
    for (let j = this.current + 1; j < this.entries.length; j++) {
      const entry = this.entries[j]
      if (entry === undefined || (entry.at !== null && entry.at > at)) break
      if (entry.at !== null) reached = j
    }
    if (reached <= this.current) return
    const status = new IOResult({ exitCode: session.lastExitCode })
    await this.close(status, records)
    for (let j = this.current + 1; j < reached; j++) {
      await this.begin(this.entries[j]?.text ?? '')
      await this.close(status, records)
    }
    this.current = reached
    await this.begin(this.entries[reached]?.text ?? '')
  }

  /** The root program read the input to its end, so the entries after its last command are read too. */
  read(): void {
    this.through = true
  }

  /** Record the line once, as typed, before it runs whole on a runtime. */
  async typed(): Promise<void> {
    if (this.current >= 0 || this.whole) return
    this.whole = true
    await this.begin(this.command)
  }

  /**
   * End the line: its last entry, with what the line wrote since and what
   * it answered with besides, or, when no command was reached, the line as
   * typed, unless its root read it through. A line ends once.
   *
   * @param io the line's result.
   * @param records the line's op records, of which the last entry's are
   *   those since the entry before ended.
   */
  async end(io: IOResult, records: readonly OpRecord[]): Promise<void> {
    if (this.done) return
    if (this.current < 0 && !this.through) await this.typed()
    await this.close(io, records)
    this.done = true
    if (!this.through || this.whole) return
    const status = new IOResult({ exitCode: io.exitCode })
    for (let j = this.current + 1; j < this.entries.length; j++) {
      await this.begin(this.entries[j]?.text ?? '')
      await this.close(status, records)
    }
  }

  private async begin(text: string): Promise<void> {
    this.line =
      this.opened === 0 || this.id === undefined ? this.id : `${this.id}.${String(this.opened)}`
    this.opened += 1
    await this.observer.logCommand(text, this.sessionId, this.session.cwd, this.line)
  }

  private async close(io: IOResult, records: readonly OpRecord[]): Promise<void> {
    if (this.opened === 0) return
    const [stdout, stderr] = this.terminal.entry()
    await this.observer.logResult(
      new IOResult({
        stdout: concat([stdout, await io.materializeStdout()]),
        stderr: concat([stderr, await io.materializeStderr()]),
        exitCode: io.exitCode,
      }),
      records.slice(this.ops),
      this.sessionId,
      this.session.cwd,
      this.line,
    )
    this.ops = records.length
  }
}
