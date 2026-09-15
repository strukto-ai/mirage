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

import { guardInput } from '../utils/limit.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { fsStrerror, isWalkError } from '../../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { respellOne } from '../../../utils/path.ts'
import { cacheAwareStream } from '../../../cache/read_through.ts'
import { mountParentReaddir, mountParentStat } from '../utils/operands.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { compilePattern, resolvePattern } from '../grep_pattern.ts'
import { BINARY_EXTENSIONS } from '../constants.ts'
import { getExtension } from '../../resolve.ts'
import { grepInput, type FlagSet } from '../grep_binary.ts'
import { fileAdmitted, dirAdmitted, parseFileGlobs } from '../grep_select.ts'
import { resolveSource } from '../utils/stream.ts'
import { UsageError } from '../../errors.ts'

const ENC = new TextEncoder()
type Stat = (p: PathSpec) => Promise<FileStat>
type Readdir = (p: PathSpec) => Promise<string[]>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

function binaryMode(fl: FlagView): string {
  let mode = 'binary'
  for (const name of fl.typedOrder('text', 'args_I', 'binary_files')) {
    if (name === 'text' && fl.asBool('text')) mode = 'text'
    else if (name === 'args_I' && fl.asBool('args_I')) mode = 'without-match'
    else if (name === 'binary_files') {
      mode = fl.asStr('binary_files') ?? 'binary'
      if (!['binary', 'text', 'without-match'].includes(mode))
        throw new Error('grep: unknown binary-files type')
    }
  }
  return mode
}

/** One -A/-B/-C value, refused the way GNU refuses it. */
function contextLength(fl: FlagView, name: string): number | undefined {
  const raw = fl.asStr(name)
  let value: number | undefined
  try {
    value = fl.asInt(name)
  } catch {
    throw new UsageError(`grep: ${raw ?? ''}: invalid context length argument`)
  }
  if (value !== undefined && value < 0) {
    throw new UsageError(`grep: ${raw ?? String(value)}: invalid context length argument`)
  }
  return value
}

/** The winning filename flag: true for -H, false for -h, null for neither. */
export function filenameMode(fl: FlagView): boolean | null {
  let mode: boolean | null = null
  for (const name of fl.typedOrder('H', 'h')) {
    if (fl.asBool(name)) mode = name === 'H'
  }
  return mode
}

/**
 * Ask for the filename a walk would have printed on its own. A content
 * search hands the generic explicit files where the user named a directory,
 * so the label is requested here; an explicit -h still wins, and an explicit
 * -H is already on the line.
 */
export function labelled(opts: CommandOpts): CommandOpts {
  if (filenameMode(new FlagView(opts.flags, specOf('grep'))) !== null) return opts
  return { ...opts, flags: { ...opts.flags, H: true } }
}

function reason(error: unknown): string {
  return fsStrerror(error) ?? (error instanceof Error ? error.message : String(error))
}

export function parseFlags(fl: FlagView): FlagSet {
  const mode = binaryMode(fl)
  const filename = filenameMode(fl)
  // GNU checks each context option as it is read, so the first bad one on
  // the line is the one named.
  const contexts = new Map<string, number | undefined>()
  for (const name of fl.typedOrder('A', 'B', 'C')) contexts.set(name, contextLength(fl, name))
  const aCtx = contexts.get('A')
  const bCtx = contexts.get('B')
  const cCtx = contexts.get('C')
  return {
    binaryMode: mode,
    recursive: fl.asBool('r') || fl.asBool('R'),
    filters: {
      fileGlobs: parseFileGlobs(fl),
      excludeDir: fl.asList('exclude_dir'),
      text: mode === 'text',
    },
    ignoreCase: fl.asBool('i'),
    invert: fl.asBool('v'),
    lineNumbers: fl.asBool('n'),
    countOnly: fl.asBool('c'),
    filesOnly: fl.asBool('args_l'),
    wholeWord: fl.asBool('w'),
    fixedString: fl.asBool('F'),
    // grep reads a basic expression unless -E says otherwise; -G asks for the
    // default explicitly.
    basicRegexp: !fl.asBool('E'),
    onlyMatching: fl.asBool('o'),
    maxCount: fl.asInt('m') ?? null,
    quiet: fl.asBool('q'),
    withFilename: filename === true,
    noFilename: filename === false,
    afterContext: aCtx ?? cCtx ?? 0,
    beforeContext: bCtx ?? cCtx ?? 0,
  }
}

function makeSpec(path: string, template: PathSpec): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    resourcePath: mountKey(path, mountPrefixOf(template.virtual, template.resourcePath)),
  })
}

export async function grepGeneric(
  name: string,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: Stat,
  readdir: Readdir,
  stream: Stream,
): Promise<CommandFnResult> {
  const cachedStream = cacheAwareStream(stream)
  stream = (path) => guardInput(cachedStream(path), opts)
  const fl = new FlagView(opts.flags, specOf('grep'))
  const resolution = await resolvePattern(name, texts, opts.flags, paths, opts.mountPrefix, stream)
  if (resolution.error !== null || resolution.pattern === null)
    return [
      null,
      new IOResult({
        exitCode: 2,
        stderr: ENC.encode(resolution.error ?? `${name}: usage: ${name} [flags] pattern [path]\n`),
      }),
    ]
  let f: FlagSet
  try {
    f = parseFlags(fl)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(error.message + '\n') })]
  }
  if (resolution.neverMatch) f.fixedString = false
  const pat = compilePattern(
    resolution.pattern,
    f.ignoreCase,
    f.fixedString,
    f.wholeWord,
    f.basicRegexp,
  )
  const io = new IOResult({ exitCode: 1 })
  const first = paths[0]
  if (first === undefined) {
    try {
      const source = guardInput(
        resolveSource(opts.stdin, `${name}: usage: ${name} [flags] pattern [path]`),
        opts,
      )
      return [
        grepInput(source, pat, f, '(standard input)', f.withFilename && !f.noFilename, io),
        io,
      ]
    } catch (error) {
      if (!(error instanceof Error)) throw error
      return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(error.message + '\n') })]
    }
  }
  const prefix = mountPrefixOf(first.virtual, first.resourcePath)
  const mounts = opts.ns?.mounts
  const rd = mountParentReaddir((p: string) => readdir(makeSpec(p, first)), mounts)
  const st = mountParentStat((p: string) => stat(makeSpec(p, first)), mounts)
  if (!f.recursive && paths.length === 1 && !(f.filesOnly || f.quiet)) {
    try {
      const info = await st(first.virtual)
      if (info.type === FileType.DIRECTORY)
        return [
          new Uint8Array(),
          new IOResult({
            exitCode: 2,
            stderr: ENC.encode(`${name}: ${first.rawPath}: Is a directory\n`),
          }),
        ]
      if (!fileAdmitted(first.virtual, f.filters)) return [new Uint8Array(), io]
      // Start the reader while the mount's cache context is still active.
      const source = stream(first)
      const singleIO = new IOResult()
      return [
        grepInput(source, pat, f, first.rawPath, f.withFilename && !f.noFilename, singleIO),
        singleIO,
      ]
    } catch (error) {
      if (!isWalkError(error)) throw error
      return [
        new Uint8Array(),
        new IOResult({
          exitCode: 2,
          stderr: ENC.encode(`${name}: ${first.rawPath}: ${reason(error)}\n`),
        }),
      ]
    }
  }
  const warnings: string[] = []
  const notices: Uint8Array[] = []
  let matched = false
  let printed = false

  function warn(message: string): void {
    warnings.push(message)
    notices.push(ENC.encode(message + '\n'))
  }

  async function* scan(p: PathSpec, walked = false): AsyncIterable<Uint8Array> {
    try {
      const info = await st(p.virtual)
      if (info.type === FileType.DIRECTORY) {
        if (!f.recursive) {
          warn(`${name}: ${p.rawPath}: Is a directory`)
          return
        }
        for (const entry of await rd(p.virtual)) {
          const child = new PathSpec({
            virtual: entry,
            directory: entry,
            resourcePath: mountKey(entry, prefix),
            rawPath: respellOne(entry, p.virtual, p.rawPath),
          })
          if (!dirAdmitted(entry, f.filters)) {
            let probe: FileStat
            try {
              probe = await st(entry)
            } catch (error) {
              if (!isWalkError(error)) throw error
              warn(`${name}: ${child.rawPath}: ${reason(error)}`)
              continue
            }
            if (probe.type === FileType.DIRECTORY) continue
          }
          yield* scan(child, true)
        }
        return
      }
      if (walked && info.type !== FileType.FILE) return
      if (walked && !f.filters.text && BINARY_EXTENSIONS.has(getExtension(p.virtual) ?? '')) return
      if (!fileAdmitted(p.virtual, f.filters)) return
      const fileIO = new IOResult({ exitCode: 1 })
      const show = !f.noFilename && (f.withFilename || walked || paths.length > 1)
      for await (const chunk of grepInput(stream(p), pat, f, p.rawPath, show, fileIO, printed)) {
        printed = true
        yield chunk
      }
      matched ||= fileIO.exitCode === 0
      if (fileIO.stderr instanceof Uint8Array) notices.push(fileIO.stderr)
    } catch (error) {
      if (!isWalkError(error)) throw error
      warn(`${name}: ${p.rawPath}: ${reason(error)}`)
    }
  }
  async function* run(): AsyncIterable<Uint8Array> {
    for (const path of paths) {
      yield* scan(path)
      if (f.quiet && matched) break
    }
    const length = notices.reduce((n, part) => n + part.length, 0)
    if (length) {
      const stderr = new Uint8Array(length)
      let offset = 0
      for (const notice of notices) {
        stderr.set(notice, offset)
        offset += notice.length
      }
      io.stderr = stderr
    }
    io.exitCode = f.quiet && matched ? 0 : warnings.length ? 2 : matched ? 0 : 1
  }
  return [await materialize(run()), io]
}
