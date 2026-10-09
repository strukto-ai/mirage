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

import type { Writable } from 'node:stream'
import type { StreamName } from '@struktoai/mirage-core/io/types'
import { Channel } from '@struktoai/mirage-core/shell/console/types'
import type { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import type { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/types'
import type { ServerChannel } from 'ssh2'
import { concat } from '@struktoai/mirage-core/io/cachable_iterator'
import { refusalLine } from '@struktoai/mirage-core/workspace/tools/io_text'
import { REFUSAL_WINDOW } from './constants.ts'

// How far the client may type or pipe ahead of whoever reads it before
// the channel is paused and SSH flow control pushes back.
export const MAX_BUFFERED = 1024 * 1024
export const MAX_LINE = 1024 * 1024
export const MAX_TERMINAL_LINE = 1024

/** A control or input limit delivered in band with channel input. */
export const Mark = {
  EOF: 'eof',
  INTERRUPT: 'interrupt',
  LIMIT: 'limit',
} as const
export type Mark = (typeof Mark)[keyof typeof Mark]

type Item = Uint8Array | Mark

const TAB = 0x09
const LF = 0x0a
const CR = 0x0d
const BS = 0x08
const BEL = 0x07
const DEL = 0x7f
const ETX = 0x03
const EOT = 0x04
const NAK = 0x15
const ESC = 0x1b
const CSI_START = 0x5b
const SS3_START = 0x4f
const ERASE = [BS, 0x20, BS]
const NEWLINE = [CR, LF]

export interface DisciplineSink {
  line(bytes: Uint8Array): void
  interrupt(): void
  eof(): void
}

type EscapeState = 'none' | 'start' | 'csi' | 'ss3'

/**
 * The cooked-mode line discipline a pty gives a shell: echo, erase
 * (Backspace, Ctrl-U), Enter, Ctrl-C and Ctrl-D, with escape sequences
 * such as arrow keys swallowed. ssh2 ships none, so every pty runs this
 * one; the Python server runs its twin only for a pty without a terminal
 * type, as asyncssh's own line editor serves the rest.
 */
export class LineDiscipline {
  private line: number[] = []
  private echoed: number[] = []
  private escape: EscapeState = 'none'
  private afterCR = false

  constructor(
    private readonly echo: (bytes: Uint8Array) => void,
    private readonly sink: DisciplineSink,
  ) {}

  feed(chunk: Uint8Array): void {
    for (const byte of chunk) this.byte(byte)
    if (this.echoed.length > 0) {
      const bytes = Uint8Array.from(this.echoed)
      this.echoed = []
      this.echo(bytes)
    }
  }

  private byte(b: number): void {
    const wasCR = this.afterCR
    this.afterCR = false
    if (this.escape !== 'none') {
      this.skipEscape(b)
      return
    }
    switch (b) {
      case CR:
        this.enter()
        this.afterCR = true
        return
      case LF:
        if (!wasCR) this.enter()
        return
      case BS:
      case DEL:
        this.erase()
        return
      case NAK:
        while (this.line.length > 0) this.erase()
        return
      case ETX:
        this.line = []
        this.sink.interrupt()
        return
      case EOT:
        if (this.line.length === 0) this.sink.eof()
        return
      case ESC:
        this.escape = 'start'
        return
      default:
        break
    }
    if (b < 0x20 && b !== TAB) return
    if (this.line.length >= MAX_TERMINAL_LINE) {
      this.echoed.push(BEL)
      return
    }
    this.line.push(b)
    this.echoed.push(b)
  }

  private enter(): void {
    this.echoed.push(...NEWLINE)
    this.line.push(LF)
    const bytes = Uint8Array.from(this.line)
    this.line = []
    this.sink.line(bytes)
  }

  private erase(): void {
    if (this.line.length === 0) return
    // One code point, not one byte: drop UTF-8 continuation bytes first.
    while (this.line.length > 1 && ((this.line.at(-1) ?? 0) & 0xc0) === 0x80) this.line.pop()
    this.line.pop()
    this.echoed.push(...ERASE)
  }

  private skipEscape(b: number): void {
    if (this.escape === 'start') {
      this.escape = b === CSI_START ? 'csi' : b === SS3_START ? 'ss3' : 'none'
      return
    }
    if (this.escape === 'ss3' || (b >= 0x40 && b <= 0x7e)) this.escape = 'none'
  }
}

/**
 * Everything the client sends on one channel, read once, in order.
 *
 * The channel's data events fill one buffer, so the prompt and the
 * running line's stdin draw from a single ordered stream (typeahead
 * survives a command that did not read it), and an interrupt is seen even
 * while nothing is reading. Ctrl-D ends input for one reader, as a
 * terminal's does; the channel's own EOF ends it for good.
 */
export class ChannelInput {
  private readonly items: Item[] = []
  private buffered = 0
  private closed = false
  private paused = false
  private echoBlocked = false
  private waiters: (() => void)[] = []
  private interruptHandler: (() => void) | null = null
  private readonly discipline: LineDiscipline | null
  private readonly onData = (chunk: Buffer): void => {
    this.received(chunk)
  }
  private readonly onEnd = (): void => {
    this.finish()
  }

  private readonly onDrain = (): void => {
    this.echoBlocked = false
    this.resume()
  }

  /** `maxLine` bounds what `readline` returns before it answers `Mark.LIMIT`. */
  constructor(
    private readonly channel: ServerChannel,
    tty: boolean,
    private readonly maxLine: number = MAX_LINE,
  ) {
    this.discipline = tty
      ? new LineDiscipline(
          (bytes) => {
            if (!channel.write(bytes)) {
              this.echoBlocked = true
              this.pause()
            }
          },
          {
            line: (bytes) => {
              this.push(bytes)
            },
            interrupt: () => {
              this.interrupted()
            },
            eof: () => {
              this.push(Mark.EOF)
            },
          },
        )
      : null
  }

  start(): void {
    this.channel.on('data', this.onData)
    this.channel.on('drain', this.onDrain)
    this.channel.on('end', this.onEnd)
    this.channel.on('close', this.onEnd)
  }

  close(): void {
    this.channel.off('data', this.onData)
    this.channel.off('drain', this.onDrain)
    this.channel.off('end', this.onEnd)
    this.channel.off('close', this.onEnd)
    this.finish()
  }

  /**
   * Route Ctrl-C or an INT signal to `handler`. With no handler, the
   * interrupt is queued in band for the prompt to read.
   */
  onInterrupt(handler: (() => void) | null): void {
    this.interruptHandler = handler
  }

  /** A signal request from the client, delivered like Ctrl-C. */
  interruptReceived(): void {
    this.interrupted()
  }

  private received(chunk: Buffer): void {
    // A copy, not the channel's buffer: the bytes may outlive this event
    // in a write buffer, and pyodide refuses a Node Buffer as stdin.
    const bytes = new Uint8Array(chunk)
    if (this.discipline !== null) this.discipline.feed(bytes)
    else this.push(bytes)
  }

  private interrupted(): void {
    if (this.interruptHandler !== null) {
      this.interruptHandler()
      return
    }
    this.push(Mark.INTERRUPT)
  }

  private push(item: Item): void {
    this.items.push(item)
    this.buffered += typeof item === 'string' ? 1 : item.byteLength
    if (this.buffered >= MAX_BUFFERED) this.pause()
    this.wake()
  }

  private took(size: number): void {
    this.buffered -= size
    this.resume()
  }

  private pause(): void {
    if (this.paused) return
    this.paused = true
    this.channel.pause()
  }

  private resume(): void {
    if (this.paused && !this.echoBlocked && this.buffered < MAX_BUFFERED) {
      this.paused = false
      this.channel.resume()
    }
  }

  private finish(): void {
    this.closed = true
    this.wake()
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  /**
   * The next line, with its newline, or the control that came first: a
   * final unterminated line at the channel's EOF is returned as is,
   * `Mark.INTERRUPT` is a Ctrl-C typed at the prompt, and `Mark.EOF` is
   * Ctrl-D or the channel's EOF, and `Mark.LIMIT` is an oversized line.
   */
  async readline(): Promise<Uint8Array | Mark> {
    const parts: Uint8Array[] = []
    let size = 0
    for (;;) {
      while (this.items.length > 0) {
        const item = this.items[0]
        if (item === undefined) break
        if (typeof item === 'string') {
          if (parts.length > 0) return concat(parts)
          this.items.shift()
          this.took(1)
          return item
        }
        const cut = item.indexOf(LF)
        size += cut < 0 ? item.byteLength : cut
        if (size > this.maxLine) return Mark.LIMIT
        if (cut < 0) {
          this.items.shift()
          this.took(item.byteLength)
          parts.push(item)
          continue
        }
        this.took(cut + 1)
        parts.push(item.subarray(0, cut + 1))
        const rest = item.subarray(cut + 1)
        if (rest.byteLength > 0) this.items[0] = rest
        else this.items.shift()
        return concat(parts)
      }
      if (this.closed) return parts.length > 0 ? concat(parts) : Mark.EOF
      await this.wait()
    }
  }

  /** The next buffered chunk for a running line's stdin; empty at Ctrl-D or EOF. */
  async read(): Promise<Uint8Array> {
    for (;;) {
      const item = this.items.shift()
      if (typeof item === 'string') this.took(1)
      if (item === Mark.EOF) return new Uint8Array(0)
      if (item !== undefined && typeof item !== 'string') {
        this.took(item.byteLength)
        return item
      }
      if (item === undefined) {
        if (this.closed) return new Uint8Array(0)
        await this.wait()
      }
    }
  }
}

function crlf(data: Uint8Array): Uint8Array {
  let lfs = 0
  for (const b of data) if (b === LF) lfs++
  if (lfs === 0) return data
  const out = new Uint8Array(data.byteLength + lfs)
  let i = 0
  for (const b of data) {
    if (b === LF) out[i++] = CR
    out[i++] = b
  }
  return out
}

function drained(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      stream.off('drain', done)
      stream.off('close', done)
      resolve()
    }
    stream.once('drain', done)
    stream.once('close', done)
  })
}

/**
 * Writes a line's output back to the client. On a terminal stderr folds
 * into stdout, as a pty points both descriptors at one device, and each
 * newline goes out as CRLF, as asyncssh's line editor does on the Python
 * side.
 */
export class ChannelOutput {
  constructor(
    private readonly channel: ServerChannel,
    private readonly tty: boolean,
  ) {}

  async write(data: Uint8Array, stderr = false): Promise<void> {
    if (data.byteLength === 0) return
    const stream: Writable = stderr && !this.tty ? this.channel.stderr : this.channel
    if (!stream.writable) return
    if (!stream.write(this.tty ? crlf(data) : data)) await drained(stream)
  }
}

/** The channel's input as a line's stdin: chunks until Ctrl-D or EOF. */
export async function* channelStdin(source: ChannelInput): AsyncGenerator<Uint8Array> {
  for (;;) {
    const chunk = await source.read()
    if (chunk.byteLength === 0) return
    yield chunk
  }
}

/**
 * A stream's first `REFUSAL_WINDOW` bytes, then on to the end of the line
 * that window cuts (at most a window more), whole lines only unless the
 * stream ends inside them. `prefix` is the stream's first two windows and
 * `total` its whole length. Mirrors Python's `head_window`.
 */
function headWindow(prefix: Uint8Array, total: number): Uint8Array {
  if (total <= REFUSAL_WINDOW) return prefix
  const end = prefix.indexOf(10, REFUSAL_WINDOW - 1)
  if (end !== -1) return prefix.subarray(0, end + 1)
  if (total <= 2 * REFUSAL_WINDOW) return prefix
  return prefix.subarray(0, prefix.subarray(0, REFUSAL_WINDOW).lastIndexOf(10) + 1)
}

/** Where a line's output goes: `send(data, stderr)`. */
export type Send = (data: Uint8Array, stderr: boolean) => Promise<void>

/**
 * A line's output through `send` as the line produces it, then the
 * refusal's line on stderr when a policy refused part of it. The
 * terminal's output goes out as the line printed it; the policy's reason
 * is the one line `refusalLine` appends, read once the line has ended,
 * since an op a streaming command reads late is refused only then.
 * Whether the output already says why is read off each stream's first
 * and last `REFUSAL_WINDOW` bytes: the first runs on to the end of the
 * line it cuts (at most a window more) and keeps whole lines only, so a
 * line split at a cut can neither pose as the diagnostic nor hide one. A
 * diagnostic deep inside a long output may be missed, which repeats the
 * reason and never drops it. Resolves to the line's final status, its
 * output already sent. Mirrors Python's `deliver`.
 */
export async function deliver(execution: ShellExecution, send: Send): Promise<ExecuteResult> {
  const prefix: Record<StreamName, Uint8Array> = { stdout: new Uint8Array(0), stderr: new Uint8Array(0) }
  const tail: Record<StreamName, Uint8Array> = { stdout: new Uint8Array(0), stderr: new Uint8Array(0) }
  const total: Record<StreamName, number> = { stdout: 0, stderr: 0 }
  for await (const { stream, data } of execution.events) {
    if (data.byteLength === 0) continue
    total[stream] += data.byteLength
    if (prefix[stream].byteLength < 2 * REFUSAL_WINDOW) {
      const room = 2 * REFUSAL_WINDOW - prefix[stream].byteLength
      prefix[stream] = concat([prefix[stream], data.subarray(0, room)])
    }
    tail[stream] = concat([tail[stream], data.subarray(-REFUSAL_WINDOW)]).subarray(-REFUSAL_WINDOW)
    await send(data, stream === Channel.STDERR)
  }
  const result = await execution.wait()
  const dec = new TextDecoder()
  const said = (Object.keys(prefix) as StreamName[])
    .flatMap((stream) => [headWindow(prefix[stream], total[stream]), tail[stream]])
    .map((bytes) => dec.decode(bytes))
    .join('\n')
  const line = refusalLine(said, result.refusal)
  if (line !== '') await send(new TextEncoder().encode(line), true)
  return result
}
