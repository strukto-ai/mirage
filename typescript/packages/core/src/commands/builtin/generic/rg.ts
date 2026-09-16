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

import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { cacheAwareStream } from '../../../cache/read_through.ts'
import { mountParentReaddir, mountParentStat } from '../utils/operands.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import { fsStrerror, isFsError, isWalkError } from '../../../utils/errors.ts'
import { respellRaw } from '../../../utils/path.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { compilePattern, resolvePattern } from '../grep_pattern.ts'
import {
  exitCodeFor,
  grepStream,
  nonzeroCountStream,
  prefixLines,
  type GrepStreamOptions,
} from '../grep_scan.ts'
import { rgFolderFiletype, rgFull } from '../rg_scan.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

type Stat = (p: PathSpec) => Promise<FileStat>
type Readdir = (p: PathSpec) => Promise<string[]>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

interface RgFlags {
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  byteOffsets: boolean
  countOnly: boolean
  filesOnly: boolean
  wholeWord: boolean
  fixedString: boolean
  onlyMatching: boolean
  withFilename: boolean
  noFilename: boolean
  maxCount: number | null
  afterContext: number
  beforeContext: number
  fileType: string | null
  globPattern: string | null
  hidden: boolean
}

function parseFlags(fl: FlagView): RgFlags {
  const a = fl.asInt('A')
  const b = fl.asInt('B')
  const c = fl.asInt('C')
  return {
    ignoreCase: fl.asBool('i'),
    invert: fl.asBool('v'),
    lineNumbers: fl.asBool('n'),
    byteOffsets: fl.asBool('byte_offset'),
    countOnly: fl.asBool('c'),
    filesOnly: fl.asBool('args_l'),
    wholeWord: fl.asBool('w'),
    fixedString: fl.asBool('F'),
    onlyMatching: fl.asBool('o'),
    withFilename: fl.asBool('H'),
    noFilename: fl.asBool('args_I'),
    maxCount: fl.asInt('m') ?? null,
    afterContext: a ?? c ?? 0,
    beforeContext: b ?? c ?? 0,
    fileType: fl.asStr('type') ?? null,
    globPattern: fl.asStr('glob') ?? null,
    hidden: fl.asBool('hidden'),
  }
}

// The stream reports selection on `io` rather than the caller reading it off
// an empty output: under -o a line whose only match is empty prints nothing
// and is still selected, so it exits 0 (GNU grep 3.11).
function streamOptionsOf(flags: RgFlags, io: IOResult): GrepStreamOptions {
  return {
    invert: flags.invert,
    lineNumbers: flags.lineNumbers,
    byteOffsets: flags.byteOffsets,
    countOnly: flags.countOnly,
    onlyMatching: flags.onlyMatching,
    maxCount: flags.maxCount,
    afterContext: flags.afterContext,
    beforeContext: flags.beforeContext,
    io,
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

export async function rgGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: Stat,
  readdir: Readdir,
  stream: Stream,
): Promise<CommandFnResult> {
  stream = cacheAwareStream(stream)
  const resolution = await resolvePattern('rg', texts, opts.flags, paths, opts.mountPrefix, stream)
  if (resolution.error !== null) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(resolution.error) })]
  }
  const exprText = resolution.pattern
  if (exprText === null) {
    return [
      null,
      new IOResult({ exitCode: 2, stderr: ENC.encode('rg: usage: rg [flags] pattern [path]\n') }),
    ]
  }
  const flags = parseFlags(new FlagView(opts.flags, specOf('rg')))
  if (resolution.neverMatch) flags.fixedString = false
  // ripgrep labels when searching multiple files; -H forces the label for a
  // single file and -I suppresses it (cross-mount fanout forces -H so
  // per-operand native runs stay filename-keyed).
  const label = (paths.length > 1 || flags.withFilename) && !flags.noFilename
  const [first] = paths

  if (first === undefined) {
    let source: AsyncIterable<Uint8Array>
    try {
      source = resolveSource(opts.stdin, 'rg: usage: rg [flags] pattern [path]')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
    }
    const pat = compilePattern(exprText, flags.ignoreCase, flags.fixedString, flags.wholeWord)
    // Seeded to 1 the way the python twin and the multi-operand branch
    // below are: grepStream flips it to 0 on the first selected line, and
    // seeding here means the status does not depend on the generator having
    // been started.
    const io = new IOResult({ exitCode: 1 })
    return [grepStream(source, pat, streamOptionsOf(flags, io)), io]
  }

  const mounts = opts.ns?.mounts
  const readdirFn = mountParentReaddir(
    (p: string): Promise<string[]> => readdir(makeSpec(p, first)),
    mounts,
  )
  const statFn = mountParentStat((p: string): Promise<FileStat> => stat(makeSpec(p, first)), mounts)
  const readBytesFn = (p: string): Promise<Uint8Array> => materialize(stream(makeSpec(p, first)))

  // Through the wrapped pair, not the raw ops: a directory that exists
  // only because mounts sit under it answers on neither, so probing raw
  // left isDir false and the operand was read as a file, which reports
  // it missing while the fan-out prints hits from the mounts below it.
  let isDir = false
  try {
    const s = await statFn(first.virtual)
    isDir = s.type === FileType.DIRECTORY
  } catch (err) {
    if (!isWalkError(err)) throw err
    try {
      await readdirFn(first.virtual)
      isDir = true
    } catch (probeErr) {
      if (!isWalkError(probeErr)) throw probeErr
      // not readable
    }
  }

  if (isDir && opts.filetypeFns !== null && Object.keys(opts.filetypeFns).length > 0) {
    const warnings: string[] = []
    const folderOpts = {
      ignoreCase: flags.ignoreCase,
      invert: flags.invert,
      lineNumbers: flags.lineNumbers,
      byteOffsets: flags.byteOffsets,
      countOnly: flags.countOnly,
      filesOnly: flags.filesOnly,
      onlyMatching: flags.onlyMatching,
      maxCount: flags.maxCount,
      fixedString: flags.fixedString,
      wholeWord: flags.wholeWord,
      fileType: flags.fileType,
      globPattern: flags.globPattern,
      hidden: flags.hidden,
    }
    const results: string[] = []
    // Status comes from selection, not from the printed lines: under -o a
    // zero-width match selects the line and prints nothing, so an empty
    // `results` is not "nothing matched". The branch below reads it the same
    // way, and so does `grep -r`.
    const folderIO = new IOResult({ exitCode: 1 })
    for (const p of paths) {
      results.push(
        ...(await rgFolderFiletype(
          readdirFn,
          statFn,
          readBytesFn,
          p.virtual,
          exprText,
          folderOpts,
          warnings,
          folderIO,
        )),
      )
    }
    const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n') + '\n') : undefined
    const code = exitCodeFor(folderIO.exitCode === 0, warnings.length > 0, false)
    if (results.length === 0) {
      const io = new IOResult({ exitCode: code, ...(stderr !== undefined ? { stderr } : {}) })
      return [new Uint8Array(0), io]
    }
    const out: ByteSource = ENC.encode(results.join('\n') + '\n')
    const io = new IOResult({
      exitCode: code,
      ...(stderr !== undefined ? { stderr } : {}),
    })
    return [out, io]
  }

  const needsFull =
    isDir ||
    flags.filesOnly ||
    flags.beforeContext > 0 ||
    flags.afterContext > 0 ||
    flags.fileType !== null ||
    flags.globPattern !== null
  if (needsFull) {
    const warnings: string[] = []
    const fullOpts = {
      ignoreCase: flags.ignoreCase,
      invert: flags.invert,
      lineNumbers: flags.lineNumbers,
      byteOffsets: flags.byteOffsets,
      countOnly: flags.countOnly,
      filesOnly: flags.filesOnly,
      fixedString: flags.fixedString,
      onlyMatching: flags.onlyMatching,
      maxCount: flags.maxCount,
      wholeWord: flags.wholeWord,
      contextBefore: flags.beforeContext,
      contextAfter: flags.afterContext,
      fileType: flags.fileType,
      globPattern: flags.globPattern,
      hidden: flags.hidden,
      noFilename: flags.noFilename,
    }
    const results: string[] = []
    // Status comes from selection, not from the printed lines: under -o a
    // zero-width match selects the line and prints nothing, so an empty
    // `results` is not "nothing matched". `grep -r` reads its status the
    // same way.
    const fullIO = new IOResult({ exitCode: 1 })
    for (const p of paths) {
      const hitsFull = await rgFull(
        readdirFn,
        statFn,
        readBytesFn,
        p.virtual,
        exprText,
        fullOpts,
        warnings,
        label ? p.rawPath : null,
        fullIO,
      )
      results.push(...respellRaw(hitsFull, p.virtual, p.rawPath))
    }
    const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n') + '\n') : undefined
    // `exitCodeFor` is the one contract both commands share: an operand the
    // search could not read is exit 2 and it outranks a match. This branch
    // answered 1 where the python twin, the multi-operand branch below and
    // `grep` all answer 2.
    const code = exitCodeFor(fullIO.exitCode === 0, warnings.length > 0, false)
    if (results.length === 0) {
      const io = new IOResult({
        exitCode: code,
        ...(stderr !== undefined ? { stderr } : {}),
      })
      return [new Uint8Array(0), io]
    }
    const out: ByteSource = ENC.encode(results.join('\n') + '\n')
    const io = new IOResult({
      exitCode: code,
      ...(stderr !== undefined ? { stderr } : {}),
    })
    return [out, io]
  }

  if (flags.countOnly) {
    const pat = compilePattern(exprText, flags.ignoreCase, flags.fixedString, flags.wholeWord)
    const streamOpts = {
      invert: flags.invert,
      lineNumbers: false,
      byteOffsets: false,
      onlyMatching: flags.onlyMatching,
      maxCount: flags.maxCount,
      countOnly: true,
      afterContext: 0,
      beforeContext: 0,
    }
    if (paths.length > 1 || flags.withFilename) {
      const results: string[] = []
      const warnings: string[] = []
      for (const p of paths) {
        let counted: Uint8Array
        try {
          counted = await materialize(grepStream(stream(p), pat, streamOpts))
        } catch (err) {
          if (!isFsError(err)) throw err
          // ripgrep reports the failed operand and keeps searching the rest.
          warnings.push(`rg: ${p.rawPath}: ${String(fsStrerror(err))}`)
          continue
        }
        const n = Number.parseInt(DEC.decode(counted).trim() || '0', 10)
        if (n > 0) results.push(label ? `${p.rawPath}:${String(n)}` : String(n))
      }
      const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n') + '\n') : undefined
      const code = exitCodeFor(results.length > 0, warnings.length > 0, false)
      if (results.length === 0)
        return [
          new Uint8Array(0),
          new IOResult({ exitCode: code, ...(stderr !== undefined ? { stderr } : {}) }),
        ]
      return [
        ENC.encode(results.join('\n') + '\n'),
        new IOResult({
          exitCode: code,
          ...(stderr !== undefined ? { stderr } : {}),
        }),
      ]
    }
    const io = new IOResult({ exitCode: 1 })
    const counted = nonzeroCountStream(grepStream(stream(first), pat, { ...streamOpts, io }))
    return [counted, io]
  }

  const pat = compilePattern(exprText, flags.ignoreCase, flags.fixedString, flags.wholeWord)
  if (paths.length > 1 || flags.withFilename) {
    const results: string[] = []
    const warnings: string[] = []
    let selected = false
    for (const p of paths) {
      let data: Uint8Array
      const fileIO = new IOResult({ exitCode: 1 })
      try {
        const matched = grepStream(stream(p), pat, streamOptionsOf(flags, fileIO))
        data = await materialize(label ? prefixLines(matched, p.rawPath + ':') : matched)
      } catch (error) {
        if (!isFsError(error)) throw error
        warnings.push(`rg: ${p.rawPath}: ${String(fsStrerror(error))}`)
        continue
      }
      selected ||= fileIO.exitCode === 0
      if (data.length) results.push(DEC.decode(data))
    }
    return [
      ENC.encode(results.join('')),
      new IOResult({
        exitCode: exitCodeFor(selected, warnings.length > 0, false),
        ...(warnings.length ? { stderr: ENC.encode(warnings.join('\n') + '\n') } : {}),
      }),
    ]
  }

  try {
    await statFn(first.virtual)
  } catch (error) {
    if (!isFsError(error)) throw error
    return [
      new Uint8Array(),
      new IOResult({
        exitCode: 2,
        stderr: ENC.encode(`rg: ${first.rawPath}: ${String(fsStrerror(error))}\n`),
      }),
    ]
  }
  const io = new IOResult({ exitCode: 1 })
  return [grepStream(stream(first), pat, streamOptionsOf(flags, io)), io]
}
