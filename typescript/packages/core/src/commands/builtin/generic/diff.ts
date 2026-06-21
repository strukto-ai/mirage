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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, type FileStat, PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { edScript, normalDiff, unifiedDiff } from '../diff_helper.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type Readdir = (p: PathSpec) => Promise<string[]>
type Stat = (p: PathSpec) => Promise<FileStat>

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function rstripSlash(s: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === '/') end--
  return s.slice(0, end)
}

interface DiffFlags {
  i: boolean
  w: boolean
  b: boolean
  e: boolean
  q: boolean
  u: boolean
}

function entryBaseName(entry: string): string {
  let end = entry.length
  while (end > 0 && entry[end - 1] === '/') end--
  const trimmed = entry.slice(0, end)
  const slash = trimmed.lastIndexOf('/')
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}

function childSpec(parent: PathSpec, name: string): PathSpec {
  let end = parent.original.length
  while (end > 0 && parent.original[end - 1] === '/') end--
  const childPath = `${parent.original.slice(0, end)}/${name}`
  return new PathSpec({
    original: childPath,
    directory: childPath,
    resolved: false,
    prefix: parent.prefix,
  })
}

function splitLinesKeepEnds(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

async function diffPair(
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  path1: PathSpec,
  path2: PathSpec,
  flags: DiffFlags,
): Promise<Uint8Array> {
  const dataA = await materialize(stream(path1))
  const dataB = await materialize(stream(path2))
  let textA = DEC.decode(dataA)
  let textB = DEC.decode(dataB)
  if (flags.i) {
    textA = textA.toLowerCase()
    textB = textB.toLowerCase()
  }
  if (flags.w) {
    textA = textA.replace(/\s+/g, '')
    textB = textB.replace(/\s+/g, '')
  }
  if (flags.b) {
    textA = textA.replace(/[ \t]+/g, ' ')
    textB = textB.replace(/[ \t]+/g, ' ')
  }
  if (flags.q) {
    if (textA !== textB) return ENC.encode(`Files ${path1.original} and ${path2.original} differ\n`)
    return new Uint8Array(0)
  }
  const aLines = splitLinesKeepEnds(textA)
  const bLines = splitLinesKeepEnds(textB)
  let result: string[]
  if (flags.e) result = edScript(aLines, bLines)
  else if (flags.u) result = unifiedDiff(aLines, bLines, path1.original, path2.original)
  else result = normalDiff(aLines, bLines)
  return ENC.encode(result.join(''))
}

async function diffDirs(
  readdir: Readdir,
  stat: Stat,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  dirA: PathSpec,
  dirB: PathSpec,
  flags: DiffFlags,
): Promise<Uint8Array> {
  const rawA = await readdir(dirA)
  const rawB = await readdir(dirB)
  const namesA = new Set(rawA.map(entryBaseName))
  const namesB = new Set(rawB.map(entryBaseName))
  const names = [...new Set([...namesA, ...namesB])].sort()
  const left = rstripSlash(dirA.original)
  const right = rstripSlash(dirB.original)
  const parts: Uint8Array[] = []
  for (const name of names) {
    if (!namesB.has(name)) {
      parts.push(ENC.encode(`Only in ${left}: ${name}\n`))
      continue
    }
    if (!namesA.has(name)) {
      parts.push(ENC.encode(`Only in ${right}: ${name}\n`))
      continue
    }
    const childA = childSpec(dirA, name)
    const childB = childSpec(dirB, name)
    const aDir = (await stat(childA)).type === FileType.DIRECTORY
    const bDir = (await stat(childB)).type === FileType.DIRECTORY
    if (aDir && bDir) {
      parts.push(await diffDirs(readdir, stat, stream, childA, childB, flags))
    } else if (!aDir && !bDir) {
      const body = await diffPair(stream, childA, childB, flags)
      if (body.byteLength > 0) {
        if (flags.q) parts.push(body)
        else
          parts.push(
            concatBytes([ENC.encode(`diff -r ${childA.original} ${childB.original}\n`), body]),
          )
      }
    } else if (aDir) {
      parts.push(
        ENC.encode(
          `File ${childA.original} is a directory while file ${childB.original} is a regular file\n`,
        ),
      )
    } else {
      parts.push(
        ENC.encode(
          `File ${childA.original} is a regular file while file ${childB.original} is a directory\n`,
        ),
      )
    }
  }
  return concatBytes(parts)
}

export async function diffGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  readdir?: Readdir,
  stat?: Stat,
): Promise<CommandFnResult> {
  if (paths.length < 2) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('diff: requires two paths\n') })]
  }
  const flags: DiffFlags = {
    i: opts.flags.i === true,
    w: opts.flags.w === true,
    b: opts.flags.b === true,
    e: opts.flags.e === true,
    q: opts.flags.q === true,
    u: opts.flags.u === true,
  }
  const p0 = paths[0]
  const p1 = paths[1]
  if (p0 === undefined || p1 === undefined) return [null, new IOResult()]
  let output: Uint8Array | undefined
  if (opts.flags.r === true && readdir !== undefined && stat !== undefined) {
    const bothDirs =
      (await stat(p0)).type === FileType.DIRECTORY && (await stat(p1)).type === FileType.DIRECTORY
    if (bothDirs) output = await diffDirs(readdir, stat, stream, p0, p1, flags)
  }
  output ??= await diffPair(stream, p0, p1, flags)
  const exitCode = output.byteLength > 0 ? 1 : 0
  const out: ByteSource = output
  return [out, new IOResult({ exitCode, cache: [p0.stripPrefix, p1.stripPrefix] })]
}
