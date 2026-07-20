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
import { exitOnEmpty } from '../../../io/stream.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import { fsStrerror, isFsError } from '../../../utils/errors.ts'
import { rebaseRaw } from '../../../utils/path.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import {
  compilePattern,
  grepStream,
  nonzeroCountStream,
  resolvePatternFromFlags,
} from '../grep_helper.ts'
import { rgFolderFiletype, rgFull } from '../rg_helper.ts'
import { resolveSource } from '../utils/stream.ts'
import { grepGeneric } from './grep.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

type Stat = (p: PathSpec) => Promise<FileStat>
type Readdir = (p: PathSpec) => Promise<string[]>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

interface RgFlags {
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
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

function parseRgFlags(flags: Record<string, string | boolean | string[]>): RgFlags {
  const toInt = (v: string | boolean | string[] | undefined): number | null =>
    typeof v === 'string' ? Number.parseInt(v, 10) : null
  const a = toInt(flags.A)
  const b = toInt(flags.B)
  const c = toInt(flags.C)
  return {
    ignoreCase: flags.i === true,
    invert: flags.v === true,
    lineNumbers: flags.n === true,
    countOnly: flags.c === true,
    filesOnly: flags.args_l === true,
    wholeWord: flags.w === true,
    fixedString: flags.F === true,
    onlyMatching: flags.o === true,
    withFilename: flags.H === true,
    noFilename: flags.args_I === true,
    maxCount: toInt(flags.m),
    afterContext: a ?? c ?? 0,
    beforeContext: b ?? c ?? 0,
    fileType: typeof flags.type === 'string' ? flags.type : null,
    globPattern: typeof flags.glob === 'string' ? flags.glob : null,
    hidden: flags.hidden === true,
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
  const resolution = await resolvePatternFromFlags(
    'rg',
    texts,
    opts.flags,
    paths,
    opts.mountPrefix,
    stream,
  )
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
  const flags = parseRgFlags(opts.flags)
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
    const matched = grepStream(source, pat, {
      invert: flags.invert,
      lineNumbers: flags.lineNumbers,
      countOnly: flags.countOnly,
      onlyMatching: flags.onlyMatching,
      maxCount: flags.maxCount,
      afterContext: flags.afterContext,
      beforeContext: flags.beforeContext,
    })
    const io = new IOResult()
    return [exitOnEmpty(matched, io), io]
  }

  let isDir = false
  try {
    const s = await stat(first)
    isDir = s.type === FileType.DIRECTORY
  } catch {
    try {
      await readdir(first)
      isDir = true
    } catch {
      // not readable
    }
  }

  const readdirFn = (p: string): Promise<string[]> => readdir(makeSpec(p, first))
  const statFn = (p: string): Promise<FileStat> => stat(makeSpec(p, first))
  const readBytesFn = (p: string): Promise<Uint8Array> => materialize(stream(makeSpec(p, first)))

  if (isDir && opts.filetypeFns !== null && Object.keys(opts.filetypeFns).length > 0) {
    const warnings: string[] = []
    const folderOpts = {
      ignoreCase: flags.ignoreCase,
      invert: flags.invert,
      lineNumbers: flags.lineNumbers,
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
        )),
      )
    }
    const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n') + '\n') : undefined
    if (results.length === 0) {
      const io = new IOResult({ exitCode: 1, ...(stderr !== undefined ? { stderr } : {}) })
      return [new Uint8Array(0), io]
    }
    const out: ByteSource = ENC.encode(results.join('\n') + '\n')
    const io = new IOResult({
      exitCode: warnings.length > 0 ? 1 : 0,
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
      )
      results.push(...rebaseRaw(hitsFull, p.virtual, p.rawPath))
    }
    const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n') + '\n') : undefined
    if (results.length === 0) {
      const io = new IOResult({ exitCode: 1, ...(stderr !== undefined ? { stderr } : {}) })
      return [new Uint8Array(0), io]
    }
    const out: ByteSource = ENC.encode(results.join('\n') + '\n')
    // A failed operand fails the command (deliberate divergence: ripgrep
    // uses exit 2 for errors, mirage flattens fs errors to 1).
    const io = new IOResult({
      exitCode: warnings.length > 0 ? 1 : 0,
      ...(stderr !== undefined ? { stderr } : {}),
    })
    return [out, io]
  }

  if (flags.countOnly) {
    const pat = compilePattern(exprText, flags.ignoreCase, flags.fixedString, flags.wholeWord)
    const streamOpts = {
      invert: flags.invert,
      lineNumbers: false,
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
      if (results.length === 0)
        return [
          new Uint8Array(0),
          new IOResult({ exitCode: 1, ...(stderr !== undefined ? { stderr } : {}) }),
        ]
      return [
        ENC.encode(results.join('\n') + '\n'),
        new IOResult({
          exitCode: warnings.length > 0 ? 1 : 0,
          ...(stderr !== undefined ? { stderr } : {}),
        }),
      ]
    }
    const io = new IOResult()
    const counted = nonzeroCountStream(grepStream(stream(first), pat, streamOpts))
    return [exitOnEmpty(counted, io), io]
  }

  // grepGeneric reads grep's -H/-h names; translate rg's -I to grep's -h so
  // suppression carries through the shared body.
  const fwd = flags.noFilename ? { ...opts, flags: { ...opts.flags, h: true } } : opts
  return grepGeneric('rg', paths, texts, fwd, stat, readdir, stream)
}
