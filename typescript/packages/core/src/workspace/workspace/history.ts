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
import { activeRecords } from '../../observe/context.ts'
import type { Observer } from '../../observe/observer.ts'
import type { OpRecord } from '../../observe/record.ts'
import type { JobConsole } from '../../shell/console/job_console.ts'
import { Terminal } from '../../shell/console/index.ts'
import { sameLine } from '../../shell/helpers.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { concat } from '../../utils/bytes.ts'
import type { SessionState } from '../session/session.ts'

declare module '../../context/session_context.ts' {
  interface Caller {
    // The typed line whose root program records its history a command
    // read at a time.
    readonly history: LineHistory | null
  }
}

/** The words a line break inside of stays in an entry as typed. */
const WORDS: ReadonlySet<string> = new Set([
  NT.STRING,
  NT.RAW_STRING,
  NT.ANSI_C_STRING,
  NT.TRANSLATED_STRING,
  NT.COMMAND_SUBSTITUTION,
  NT.ARITHMETIC_EXPANSION,
  NT.PROCESS_SUBSTITUTION,
  NT.EXPANSION,
])

/** The tokens a command reads on after, so a line break after one joins as a space. */
const OPENERS: ReadonlySet<string> = new Set([
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '{',
  '(',
  'in',
  '|',
  '|&',
  '||',
  '&&',
  ';',
  ';;',
  ';&',
  ';;&',
  '&',
  '!',
  'case',
  'for',
  'select',
  'function',
  'time',
])

/** One entry bash's history adds for an input it reads. */
export interface HistoryEntry {
  /** The entry, its lines joined as `cmdhist` joins them. */
  readonly text: string
  /** Where its first command starts in the text the tree reads; null for a line of blanks. */
  readonly at: number | null
}

function descendants(node: TSNodeLike): TSNodeLike[] {
  return [node, ...node.children.flatMap(descendants)]
}

/**
 * The entries bash's history adds for an input it reads interactively:
 * one per command it reads, a command and what else is on the line it
 * ends on. A command spanning lines is one entry, its lines joined as
 * `cmdhist` joins them: a break inside a quoted word, a substitution or
 * a heredoc stays, a backslash's goes, and any other is a `; ` or, after
 * a token a command reads on after (`then`, `|`, `{`, a case pattern's
 * `)`), a space. A comment line inside a command is dropped, a line of
 * blanks is an entry of its own and an empty line none. Pinned against
 * Debian Bash 5.2.37 with `set +H`. Mirrors Python's history_entries.
 *
 * @param root the parsed input.
 */
export function historyEntries(root: TSNodeLike): HistoryEntry[] {
  const source = root.sourceText ?? root.text
  const base = root.startIndex ?? 0
  const typed = (index: number): number => root.offsets?.[index] ?? index
  const breaks = new Map<number, number>()
  for (let i = 0; i < root.text.length; i++)
    if (root.text[i] === '\n') breaks.set(typed(base + i), base + i)
  const groups: TSNodeLike[][] = []
  for (const child of root.children) {
    if (child.isNamed !== true) continue
    const group = groups[groups.length - 1]
    const last = group?.[group.length - 1]
    if (group !== undefined && last !== undefined && sameLine(root, last, child)) group.push(child)
    else groups.push([child])
  }
  const entries: HistoryEntry[] = []
  let read = 0
  for (const group of groups) {
    const first = group[0]
    if (first === undefined) continue
    const nodes = group.flatMap(descendants)
    const folded = nodes.filter((node) => node.heredoc !== undefined)
    const inside = (node: TSNodeLike): boolean =>
      folded.some(
        (doc) =>
          (doc.startIndex ?? 0) <= (node.startIndex ?? 0) &&
          (node.endIndex ?? 0) <= (doc.endIndex ?? 0),
      )
    const start = source.lastIndexOf('\n', typed(first.startIndex ?? 0) - 1) + 1
    const end = Math.max(
      ...nodes
        .filter((node) => node.children.length === 0 && !inside(node))
        .map((node) => typed((node.endIndex ?? 0) - 1) + 1),
      ...folded.map((doc) => doc.heredoc?.end ?? 0),
    )
    const found = source.indexOf('\n', end - 1)
    const stop = found < 0 ? source.length : found
    for (const row of source.slice(read, start).split('\n'))
      if (row !== '' && row.trim() === '') entries.push({ text: row, at: null })
    read = stop + 1
    if (nodes.some((node) => node.type === NT.ERROR)) {
      entries.push({ text: source.slice(start, stop), at: first.startIndex ?? 0 })
      continue
    }
    const comments = new Set(
      nodes.filter((node) => node.type === NT.COMMENT).map((node) => typed(node.startIndex ?? 0)),
    )
    const within = (index: number): boolean =>
      nodes.some(
        (node) =>
          WORDS.has(node.type) && (node.startIndex ?? 0) < index && index < (node.endIndex ?? 0),
      )
    const joint = (at: number): string => {
      const docs = folded.filter(
        (doc) => doc.heredoc !== undefined && doc.heredoc.wordEnd <= at && at < doc.heredoc.end,
      )
      if (docs.length > 0) {
        if (!docs.every((doc) => at === (doc.heredoc?.end ?? 0) - 1)) return '\n'
        return docs.some((doc) => within(doc.startIndex ?? 0)) ? '\n\n' : '\n '
      }
      const index = breaks.get(at)
      if (index === undefined) {
        let before = base
        for (let i = base; i < base + root.text.length; i++) if (typed(i) < at - 1) before = i
        return within(before) || source[at - 1] !== '\\' ? '\n' : ''
      }
      if (within(index)) return '\n'
      if (
        nodes.some(
          (node) =>
            node.type === NT.ARRAY &&
            (node.startIndex ?? 0) < index &&
            index < (node.endIndex ?? 0),
        )
      )
        return ' '
      let leaf: TSNodeLike | undefined
      for (const node of nodes)
        if (
          node.children.length === 0 &&
          (node.endIndex ?? 0) <= index &&
          (leaf === undefined || (node.endIndex ?? 0) >= (leaf.endIndex ?? 0))
        )
          leaf = node
      if (leaf === undefined) return '; '
      if (leaf.type === NT.COMMENT) return '\n'
      if (leaf.isNamed !== true && OPENERS.has(leaf.type)) return ' '
      const pattern = leaf.parent?.type
      if (leaf.type === ')' && (pattern === NT.CASE_ITEM || pattern === NT.FUNCTION_DEFINITION))
        return ' '
      return '; '
    }
    let text = ''
    let blank = false
    let comment = false
    for (let at = start; ;) {
      const next = source.indexOf('\n', at)
      const ends = next < 0 || next > stop ? stop : next
      const row = source.slice(at, ends)
      if (at === start) text = row
      else {
        const between = joint(at - 1)
        const word = between.startsWith('\n')
        if (!word && comments.has(at + row.length - row.trimStart().length)) comment = true
        else {
          const joined = comment ? '\n' : blank && !word ? ' ' : between
          text = (between === '' ? text.slice(0, -1) : text) + joined + row
          blank = !word && row.trim() === ''
          comment = false
        }
      }
      if (ends >= stop) break
      at = ends + 1
    }
    if (folded.some((doc) => (doc.heredoc?.end ?? 0) - 1 === stop)) text += '\n'
    entries.push({ text, at: first.startIndex ?? 0 })
  }
  return entries
}

/**
 * A typed line's history, recorded as bash's line reader adds it: an entry
 * per command the line reads, each with what it wrote to the terminal and
 * the status it left, where a line of one command is recorded whole. The
 * line's root program reaches each command as it runs it (`reach`), and
 * the line's end ends the last (`end`). A line answered before its tree
 * runs, or run whole on a runtime (`typed`), is recorded once, as typed.
 * Mirrors Python's LineHistory.
 */
export class LineHistory {
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
    readonly root: TSNodeLike,
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
   * Reach the command the root program runs next: end the entry before it
   * and record the entries up to it, its own last.
   *
   * @param child the root's statement about to run.
   * @param session the shell running it, whose `$?` ends the entry before.
   */
  async reach(child: TSNodeLike, session: SessionState): Promise<void> {
    if (this.whole || this.done) return
    const at = child.startIndex ?? 0
    let reached = this.current
    for (let j = this.current + 1; j < this.entries.length; j++) {
      const entry = this.entries[j]
      if (entry === undefined || (entry.at !== null && entry.at > at)) break
      if (entry.at !== null) reached = j
    }
    if (reached <= this.current) return
    const status = new IOResult({ exitCode: session.lastExitCode })
    const records = activeRecords() ?? []
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
   * typed. A line ends once.
   *
   * @param io the line's result.
   * @param records the line's op records, of which the last entry's are
   *   those since the entry before ended.
   */
  async end(io: IOResult, records: readonly OpRecord[]): Promise<void> {
    if (this.done) return
    if (this.current < 0) await this.typed()
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
