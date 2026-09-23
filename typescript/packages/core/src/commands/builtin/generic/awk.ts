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

import { isStdin } from '../utils/stream.ts'
import { stdinStream } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { chunks } from '../../../io/cooperative.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import {
  AwkRuntimeError,
  AwkSyntaxError,
  ExitProgram,
  Interpreter,
  parse,
  takeRecord,
  text,
} from '../../../core/awk/index.ts'
import { UsageError } from '../../errors.ts'
import { FS_ESCAPES, USAGE, type AwkFlags } from './awk_types.ts'
import { isMissingPath, isWalkError, fsStrerror } from '../../../utils/errors.ts'
import { resolvePath } from '../../../utils/path.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

type Source = readonly [name: string, bytes: AsyncIterable<Uint8Array>]

function parseFlags(opts: CommandOpts): AwkFlags {
  const fl = new FlagView(opts.flags, specOf('awk'))
  const assignments = fl.asList('v')
  const programFiles = fl.asList('f')
  return {
    fieldSeparator: fl.asStr('F') ?? null,
    assignments,
    programFiles,
  }
}

/** Expand the backslash escapes awk reads in a -F or -v argument. */
function unescape(raw: string): string {
  let out = ''
  let idx = 0
  while (idx < raw.length) {
    if (raw.charAt(idx) === '\\' && idx + 1 < raw.length) {
      const nxt = raw.charAt(idx + 1)
      out += FS_ESCAPES[nxt] ?? '\\' + nxt
      idx += 2
      continue
    }
    out += raw.charAt(idx)
    idx += 1
  }
  return out
}

function splitAssignments(raw: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of raw) {
    const eq = item.indexOf('=')
    if (eq >= 0) out[item.slice(0, eq)] = unescape(item.slice(eq + 1))
  }
  return out
}

function exitStatus(code: number): number {
  return Number(BigInt.asUintN(8, BigInt(code)))
}

/**
 * Close a phase: move /dev/stderr text and a fatal error onto `io`.
 * Every awk treats a runtime error as fatal at exit 2 and keeps what it
 * had already written, so the pending stdout is handed back either way.
 */
async function settle(
  io: IOResult,
  interp: Interpreter,
  failure: Error | null,
  opts: CommandOpts,
): Promise<[Uint8Array, boolean]> {
  const out: string[] = []
  let err = ''
  const pending = interp.drainOutput()
  for (const [name, body, append] of pending) {
    if (name === null) out.push(body)
    else if (name === '/dev/stderr') err += body
    else {
      if (opts.dispatch === undefined) {
        failure = new AwkRuntimeError('awk: file output requires a workspace')
        break
      }
      const path = PathSpec.fromStrPath(resolvePath(name, opts.cwd))
      try {
        await opts.dispatch(append ? 'append' : 'write', path, [ENC.encode(body)])
      } catch (error) {
        if (!isWalkError(error)) throw error
        const detail = fsStrerror(error) ?? 'Cannot write output file'
        failure = new AwkRuntimeError(`awk: cannot open "${name}" for output (${detail})`)
        break
      }
    }
  }
  if (failure !== null) {
    io.exitCode = 2
    err += `${failure.message}\n`
  }
  if (err !== '') {
    const held = io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : ''
    io.stderr = ENC.encode(held + err)
  }
  return [ENC.encode(out.join('')), failure !== null]
}

function isFatal(err: unknown): err is AwkRuntimeError | AwkSyntaxError {
  return err instanceof AwkRuntimeError || err instanceof AwkSyntaxError
}

/**
 * Cut one input into records with the RS in force at each read. RS is
 * read again before every record, so an action that assigns it changes
 * how the next record is cut, as in every awk.
 */
async function* records(
  source: AsyncIterable<Uint8Array>,
  interp: Interpreter,
): AsyncIterable<string> {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const budget = new YieldBudget()
  const pulled = chunks(source)
  let buffer = ''
  let start = 0
  let final = false
  try {
    while (!final) {
      const next = await pulled.next()
      final = next.done === true
      const decoded =
        next.done === true ? decoder.decode() : decoder.decode(next.value, { stream: true })
      buffer = buffer.slice(start) + decoded
      start = 0
      for (;;) {
        const pending = budget.run()
        if (pending !== undefined) await pending
        const [record, after] = takeRecord(buffer, start, interp.special('RS'), final)
        start = after
        if (record === null) break
        yield record
      }
    }
  } finally {
    await pulled.return?.()
  }
}

async function* awkStream(
  sources: readonly Source[],
  interp: Interpreter,
  io: IOResult,
  opts: CommandOpts,
): AsyncIterable<Uint8Array> {
  let exited = false
  try {
    interp.runBegin()
  } catch (err) {
    if (err instanceof ExitProgram) {
      io.exitCode = exitStatus(err.code)
      exited = true
    } else if (isFatal(err)) {
      const [chunk] = await settle(io, interp, err, opts)
      yield chunk
      return
    } else throw err
  }
  {
    const [chunk, failed] = await settle(io, interp, null, opts)
    yield chunk
    if (failed) return
  }
  if (!exited && interp.hasMainRules()) {
    for (const [name, source] of sources) {
      if (exited) break
      interp.startFile(name)
      try {
        for await (const record of records(source, interp)) {
          interp.runRecord(record)
          const [chunk, failed] = await settle(io, interp, null, opts)
          if (chunk.length > 0) yield chunk
          if (failed) return
          if (interp.skipFile) break
        }
      } catch (err) {
        if (err instanceof ExitProgram) {
          io.exitCode = exitStatus(err.code)
          exited = true
        } else if (isFatal(err)) {
          const [chunk] = await settle(io, interp, err, opts)
          yield chunk
          return
        } else throw err
      }
    }
  }
  try {
    interp.runEnd()
  } catch (err) {
    if (err instanceof ExitProgram) io.exitCode = exitStatus(err.code)
    else if (isFatal(err)) {
      const [chunk] = await settle(io, interp, err, opts)
      yield chunk
      return
    } else throw err
  }
  {
    const [chunk, failed] = await settle(io, interp, null, opts)
    yield chunk
    if (failed) return
  }
}

export async function awkGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, opts.stdin)
  const f = parseFlags(opts)
  let program: string
  if (f.programFiles.length > 0) {
    const mountPrefix =
      (paths[0] === undefined ? undefined : mountPrefixOf(paths[0].virtual, paths[0].vfsPath)) ??
      opts.mountPrefix ??
      ''
    const pieces: string[] = []
    for (const programFile of f.programFiles) {
      // A relative -f resolves against the cwd, like the shell classifier
      // resolves python's PathSpec flag values.
      const virtual = resolvePath(programFile, opts.cwd)
      const programSpec = PathSpec.fromStrPath(virtual, mountKey(virtual, mountPrefix))
      try {
        pieces.push(DEC.decode(await materialize(stream(programSpec))))
      } catch (err) {
        // GNU awk exits 2 when a -f program file cannot be opened;
        // anything that is not absence keeps propagating.
        if (!isMissingPath(err)) throw err
        const msg = `awk: ${programFile}: No such file or directory`
        return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
      }
    }
    program = pieces.join('\n')
  } else if (texts.length > 0 && texts[0] !== undefined) {
    program = texts[0]
  } else {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${USAGE}\n`) })]
  }

  let interp: Interpreter
  try {
    interp = new Interpreter(parse(program), splitAssignments(f.assignments))
  } catch (err) {
    if (err instanceof AwkSyntaxError) throw new UsageError(err.message)
    throw err
  }
  if (f.fieldSeparator !== null) interp.setVar('FS', text(unescape(f.fieldSeparator)))

  let sources: Source[]
  let cache: string[]
  if (paths.length > 0) {
    // FILENAME reports the operand as typed, matching every awk.
    sources = paths.map((p) => [p.rawPath, stream(p)] as const)
    cache = paths.filter((p) => !isStdin(p)).map((p) => p.mountPath)
  } else {
    sources = [['', resolveSource(opts.stdin)]]
    cache = []
  }
  const io = new IOResult({ cache })
  return [awkStream(sources, interp, io, opts), io]
}
