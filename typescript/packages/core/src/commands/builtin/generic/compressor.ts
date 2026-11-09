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

import { fsStrerror, isEisdir, isFsError } from '../../../errors/fs.ts'
import { ByteSpool } from '../../../io/spool.ts'
import { OutputStream, closeQuietly, drain } from '../../../io/stream.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { LineFacts, PathSpec, type StatFn } from '../../../types.ts'
import { GzipDataError, decodeStream, encodeStream } from '../../../utils/compress.ts'
import { stripSlash } from '../../../utils/slash.ts'
import type { CommandFnResult } from '../../config.ts'
import type { FlagView } from '../../spec/flag_view.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import type { LinkResolver } from '../utils/links.ts'
import { formatRecords } from '../utils/output.ts'
import { stdinStream } from '../utils/stream.ts'
import {
  type SetAttrsFn,
  besideLink,
  inputInfo,
  keepAttributes,
  outputTaken,
  removeInput,
  replaceOutput,
} from './decompress.ts'

// The keys a program's table answers, one for each way an input is refused.
export const OPEN = 'open'
export const DIRECTORY = 'directory'
export const LINK = 'link'
export const HAS_SUFFIX = 'has_suffix'
export const UNKNOWN_SUFFIX = 'unknown_suffix'
export const OUTPUT_EXISTS = 'output_exists'
export const CREATE = 'create'
export const BAD_FORMAT = 'bad_format'

/** What a decoder's failure comes to. */
export interface Refused {
  lines: string
  code: number
  fatal?: boolean
}

/** One compressor's words and names. */
export interface Tool {
  program: string
  codec: string
  words: Readonly<Record<string, readonly [string, number]>>
  suffixes: readonly (readonly [string, string])[]
  firstErrorSticks: boolean
  decodeFailed: (
    error: GzipDataError,
    program: string,
    name: string,
    out: string | null,
    test: boolean,
  ) => Refused
  silencedAt: Readonly<Record<number, number>>
  guessedEnding?: string
  magic?: Uint8Array
  summary?: (name: string, readIn: number, written: number, longest: number) => string
  decodedNote?: (name: string, longest: number, test: boolean) => string
}

export interface CompressorFlags {
  decompress: boolean
  test: boolean
  keep: boolean
  force: boolean
  toStdout: boolean
  quiet: number
  verbose: number
  level: number
  suffix: string | null
}

/** A compressor line replaces its operands unless `-c` or `-t`. */
export function compressorFacts(fl: FlagView, operands: readonly (string | PathSpec)[]): LineFacts {
  return new LineFacts({
    writes: operands.length > 0 && !['stdout', 'test'].some((name) => fl.asBool(name)),
  })
}

/** Of a family where the last one typed wins, that one's key. */
export function lastTyped(fl: FlagView, ...names: string[]): string | null {
  const typed = fl.typedOrder(...names).filter((name) => fl.asBool(name))
  return typed[typed.length - 1] ?? null
}

function endingOf(raw: string, tool: Tool, suffix: string | null): readonly [string, string] {
  const custom: readonly (readonly [string, string])[] = suffix === null ? [] : [[suffix, '']]
  for (const [ending, swap] of [...custom, ...tool.suffixes]) {
    if (raw.endsWith(ending) && raw.length > ending.length) return [ending, swap]
  }
  return ['', '']
}

function exitAfter(tool: Tool, current: number, code: number): number {
  if (tool.firstErrorSticks && (current === 1 || code === 1)) return 1
  return Math.max(current, code)
}

function renamed(path: string, ending: string, addition: string): string {
  return path.slice(0, path.length - ending.length) + addition
}

async function* counted(
  source: AsyncIterable<Uint8Array>,
  count: number[],
): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of source) {
      count[0] = (count[0] ?? 0) + chunk.byteLength
      yield chunk
    }
  } finally {
    await closeQuietly(source)
  }
}

async function* resumed(
  first: IteratorResult<Uint8Array>,
  rest: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    if (first.done === true) return
    yield first.value
    for (;;) {
      const next = await rest.next()
      if (next.done === true) return
      yield next.value
    }
  } finally {
    await rest.return?.()
  }
}

export interface CompressorFiles {
  read: (path: PathSpec) => AsyncIterable<Uint8Array>
  write?: (path: PathSpec, data: ByteSource) => Promise<void>
  unlink?: (path: PathSpec) => Promise<void>
  stat?: StatFn
  setAttrs?: SetAttrsFn
}

/** Compress, decompress or test each operand, standard input for none or
 * for `-`, an in-place output replacing its input. */
export async function compressFiles(
  paths: PathSpec[],
  tool: Tool,
  flags: CompressorFlags,
  files: CompressorFiles,
  stdin: ByteSource | null,
  resolver: LinkResolver | null,
): Promise<CommandFnResult> {
  const operands = paths.length > 0 ? paths : [STDIN_OPERAND]
  const piped = stdinStream(files.read, stdin)
  const decoding = flags.decompress || flags.test
  const defaultSuffix = flags.suffix ?? tool.suffixes[0]?.[0] ?? ''
  const longest = Math.max(7, ...operands.map((p) => p.rawPath.length))
  const io = new IOResult()
  const lines: string[] = []
  const note = (line: string): void => {
    lines.push(line.replace(/\n$/, ''))
    io.stderr = formatRecords(lines)
  }
  const report = (line: string, code: number): void => {
    io.exitCode = exitAfter(tool, io.exitCode, code)
    const hiddenAt = tool.silencedAt[code]
    if (hiddenAt === undefined || flags.quiet < hiddenAt) note(line)
  }
  const say = (key: string, fields: Readonly<Record<string, string>>): void => {
    const entry = tool.words[key]
    if (entry === undefined) throw new Error(`no words for ${key}`)
    const line = entry[0].replace(/\{(\w+)\}/g, (_, field: string) =>
      field === 'p' ? tool.program : (fields[field] ?? ''),
    )
    report(line, entry[1])
  }
  const told = (name: string, readIn: number, written: number): void => {
    if (flags.verbose === 0) return
    if (decoding) {
      if (tool.decodedNote !== undefined) note(tool.decodedNote(name, longest, flags.test))
    } else if (tool.summary !== undefined) {
      note(tool.summary(name, readIn, written, longest))
    }
  }
  const naming = (raw: string, head: Uint8Array | undefined): readonly [string, string] | null => {
    if (!decoding) {
      const known = tool.suffixes.map(([ending]) => ending).filter((e) => raw.endsWith(e))
      if (flags.suffix !== null && raw.endsWith(flags.suffix)) known.unshift(flags.suffix)
      const found = known[0]
      if (found !== undefined) {
        say(HAS_SUFFIX, { name: raw, suffix: found })
        return null
      }
      return ['', defaultSuffix]
    }
    const [ending, swap] = endingOf(raw, tool, flags.suffix)
    if (ending !== '') return [ending, swap]
    const { magic } = tool
    if (magic !== undefined && !magic.every((byte, i) => head?.[i] === byte)) {
      say(BAD_FORMAT, { name: raw })
      return null
    }
    say(UNKNOWN_SUFFIX, { name: raw })
    return tool.guessedEnding === undefined ? null : ['', tool.guessedEnding]
  }
  async function* run(): AsyncGenerator<Uint8Array> {
    for (const p of operands) {
      const onStdin = p.rawPath === '-'
      const name = onStdin ? '(stdin)' : p.rawPath
      const inPlace = !(flags.toStdout || flags.test || onStdin)
      const link = resolver !== null && !onStdin ? resolver.linkAt(p) : null
      if (link !== null && inPlace && !flags.force) {
        say(LINK, { name })
        continue
      }
      const reading = (onStdin ? piped(p) : files.read(p))[Symbol.asyncIterator]()
      let first: IteratorResult<Uint8Array>
      try {
        first = await reading.next()
      } catch (error) {
        if (isEisdir(error)) {
          say(DIRECTORY, { name })
          continue
        }
        if (!isFsError(error)) throw error
        say(OPEN, { name, why: String(fsStrerror(error)) })
        continue
      }
      const opened = resumed(first, reading)
      try {
        const renaming = inPlace
          ? naming(p.rawPath, first.done === true ? undefined : first.value)
          : null
        if (inPlace && renaming === null) continue
        let wanted: string | null = null
        let out: PathSpec | null = null
        if (renaming !== null) {
          wanted = renamed(p.rawPath, renaming[0], renaming[1])
          out =
            link !== null
              ? besideLink(link, wanted)
              : PathSpec.fromStrPath(`/${stripSlash(renamed(p.virtual, renaming[0], renaming[1]))}`)
          const existed = await outputTaken(out, files.stat, resolver)
          if (existed && !flags.force) {
            say(OUTPUT_EXISTS, { out: wanted, name })
            continue
          }
        }
        const info = out === null ? null : await inputInfo(files.stat, p, link, resolver)
        const readIn = [0]
        const written = [0]
        const coded = counted(
          decoding
            ? decodeStream(counted(opened, readIn), tool.codec, flags.test)
            : encodeStream(counted(opened, readIn), tool.codec, flags.level),
          written,
        )
        if (out === null || wanted === null) {
          try {
            for await (const chunk of coded) {
              if (!flags.test) yield chunk
            }
          } catch (error) {
            if (!(error instanceof GzipDataError)) throw error
            const refused = tool.decodeFailed(error, tool.program, name, null, flags.test)
            report(refused.lines, refused.code)
            if (refused.fatal === true) return
            continue
          }
          told(name, readIn[0] ?? 0, written[0] ?? 0)
          continue
        }
        if (files.write === undefined || files.unlink === undefined)
          throw new Error('in-place compression requires write and unlink')
        const spool = new ByteSpool()
        try {
          try {
            await spool.fill(coded)
          } catch (error) {
            if (!(error instanceof GzipDataError)) throw error
            const refused = tool.decodeFailed(error, tool.program, name, wanted, false)
            report(refused.lines, refused.code)
            if (refused.fatal === true) return
            continue
          }
          try {
            await replaceOutput(out, spool.stream(), files.write, resolver, link !== null)
          } catch (error) {
            if (!isFsError(error)) throw error
            say(CREATE, { out: wanted, why: String(fsStrerror(error)) })
            continue
          }
        } finally {
          await spool.close()
        }
        await keepAttributes(files.setAttrs, out, info)
        told(name, readIn[0] ?? 0, written[0] ?? 0)
        if (!flags.keep) await removeInput(p, link, files.unlink, resolver)
      } finally {
        await closeQuietly(opened)
      }
    }
  }
  const body = new OutputStream(run(), () => closeQuietly(stdin))
  if (!flags.toStdout && operands.every((p) => p.rawPath !== '-')) {
    await drain(body)
    return [null, io]
  }
  return [body, io]
}
