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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { inflateRaw } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { lstripSlash, rstripSlash, stripSlash } from '../../../utils/slash.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

interface ZipEntry {
  name: string
  size: number
  data: Uint8Array
}

// Info-ZIP's wording and spacing, verbatim (two spaces after the colon).
const CAUTION_PREFIX = 'caution: filename not matched:  '

// Info-ZIP matches filespecs against the encoded name, so `?` stands for
// one byte, not one code point: `?.txt` misses `é.txt` and `??.txt` hits
// it. Both sides are flattened to one UTF-16 unit per byte so the regex
// counts bytes.
function byteString(s: string): string {
  const bytes = ENC.encode(s)
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return out
}

function memberRegex(pattern: string): RegExp {
  let out = '^'
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i] ?? ''
    if (ch === '*') {
      while (pattern[i] === '*') i++
      out += '[\\s\\S]*'
      continue
    }
    if (ch === '?') {
      out += '[\\s\\S]'
      i++
      continue
    }
    if (ch === '[') {
      let j = i + 1
      if (pattern[j] === '!' || pattern[j] === '^') j++
      if (pattern[j] === ']') j++
      while (j < pattern.length && pattern[j] !== ']') j++
      if (j >= pattern.length) {
        out += '\\['
        i++
        continue
      }
      let cls = pattern.slice(i + 1, j).replace(/\\/g, '\\\\')
      if (cls.startsWith('!')) cls = '^' + cls.slice(1)
      out += '[' + cls + ']'
      i = j + 1
      continue
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    i++
  }
  return new RegExp(out + '$')
}

interface MemberSelection {
  selected: ZipEntry[]
  unmatched: string[]
}

// Info-ZIP walks the archive in order and charges each entry to the
// first filespec that matches it, so a spec shadowed by an earlier one
// reports "filename not matched" even when its file was printed.
function selectEntries(entries: ZipEntry[], members: readonly string[]): MemberSelection {
  if (members.length === 0) return { selected: entries, unmatched: [] }
  const regexes = members.map((m) => memberRegex(byteString(m)))
  const hit = members.map(() => false)
  const selected: ZipEntry[] = []
  for (const e of entries) {
    const name = byteString(e.name)
    const idx = regexes.findIndex((r) => r.test(name))
    if (idx === -1) continue
    hit[idx] = true
    selected.push(e)
  }
  const unmatched = members.filter((_, i) => hit[i] !== true)
  return { selected, unmatched }
}

function cautionText(unmatched: readonly string[]): string {
  return unmatched.map((m) => CAUTION_PREFIX + m + '\n').join('')
}

function readU16LE(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8)
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) |
      ((data[offset + 1] ?? 0) << 8) |
      ((data[offset + 2] ?? 0) << 16) |
      ((data[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

async function readZipEntries(data: Uint8Array): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = []
  let offset = 0
  while (offset + 4 <= data.byteLength) {
    const sig = readU32LE(data, offset)
    if (sig !== 0x04034b50) break
    const compressionMethod = readU16LE(data, offset + 8)
    const compressedSize = readU32LE(data, offset + 18)
    const uncompressedSize = readU32LE(data, offset + 22)
    const nameLen = readU16LE(data, offset + 26)
    const extraLen = readU16LE(data, offset + 28)
    const headerEnd = offset + 30 + nameLen + extraLen
    const nameBytes = data.subarray(offset + 30, offset + 30 + nameLen)
    const name = DEC.decode(nameBytes)
    const body = data.subarray(headerEnd, headerEnd + compressedSize)
    let content: Uint8Array
    if (compressionMethod === 0) {
      content = body.slice()
    } else if (compressionMethod === 8) {
      content = await inflateRaw(body)
    } else {
      throw new Error(`unzip: unsupported compression method: ${String(compressionMethod)}`)
    }
    entries.push({ name, size: uncompressedSize, data: content })
    offset = headerEnd + compressedSize
  }
  return entries
}

function makePathSpec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: stripSlash(virtual),
    resolved: true,
  })
}

async function ensureParents(
  mkdir: (p: PathSpec, parents?: boolean) => Promise<void>,
  path: string,
): Promise<void> {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return
  const dir = path.slice(0, idx)
  if (dir === '' || dir === '/') return
  await mkdir(makePathSpec(dir), true)
}

export async function unzipGeneric(
  paths: PathSpec[],
  members: readonly string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  mkdir: (p: PathSpec, parents?: boolean) => Promise<void>,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('unzip'))
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('unzip: missing operand\n') })]
  }
  const archivePath = paths[0]
  if (archivePath === undefined) return [null, new IOResult()]
  const data = await materialize(stream(archivePath))
  const entries = await readZipEntries(data)
  const { selected, unmatched } = selectEntries(entries, members)

  const listMode = fl.asBool('args_l')
  const testMode = fl.asBool('t')
  const pipeMode = fl.asBool('p')
  const quiet = fl.asBool('q')
  const mountPrefix = mountPrefixOf(archivePath.virtual, archivePath.resourcePath)
  const destRaw = fl.asStr('d') ?? '/'
  const dest =
    mountPrefix !== '' && destRaw.startsWith(mountPrefix + '/')
      ? destRaw.slice(mountPrefix.length)
      : destRaw === mountPrefix
        ? '/'
        : destRaw

  if (listMode) {
    const lines = ['  Length      Name', '---------  ----']
    for (const e of selected) {
      lines.push(`${String(e.size).padStart(9, ' ')}  ${e.name}`)
    }
    const out: ByteSource = ENC.encode(lines.join('\n') + '\n')
    // GNU -l prints no caution lines and only exits 11 when the member
    // list matched nothing at all.
    if (members.length > 0 && selected.length === 0) {
      return [out, new IOResult({ exitCode: 11 })]
    }
    return [out, new IOResult()]
  }

  if (testMode) {
    // GNU -t reports unmatched members on stdout and counts them as
    // errors.
    if (unmatched.length > 0) {
      const msg =
        cautionText(unmatched) + `At least one error was detected in ${archivePath.virtual}.\n`
      return [ENC.encode(msg), new IOResult({ exitCode: 11 })]
    }
    const msg = `No errors detected in ${archivePath.virtual}\n`
    const out: ByteSource = ENC.encode(msg)
    return [out, new IOResult()]
  }

  if (pipeMode) {
    const chunks: Uint8Array[] = []
    for (const e of selected) {
      if (!e.name.endsWith('/')) chunks.push(e.data)
    }
    let total = 0
    for (const c of chunks) total += c.byteLength
    const merged = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.byteLength
    }
    const out: ByteSource = merged
    if (unmatched.length > 0) {
      return [out, new IOResult({ exitCode: 11, stderr: ENC.encode(cautionText(unmatched)) })]
    }
    return [out, new IOResult()]
  }

  const writes: Record<string, Uint8Array> = {}
  const outputLines: string[] = []
  for (const e of selected) {
    const entryName = lstripSlash(e.name)
    const outPath = rstripSlash(dest) + '/' + rstripSlash(entryName)
    const reportPath = mountPrefix !== '' ? mountPrefix + outPath : outPath
    if (e.name.endsWith('/')) {
      // A directory entry is the only record an empty directory leaves,
      // so it has to be recreated even though nothing is written inside
      // it.
      await mkdir(makePathSpec(outPath), true)
      if (!quiet) outputLines.push(`   creating: ${reportPath}/`)
      continue
    }
    await ensureParents(mkdir, outPath)
    await write(makePathSpec(outPath), e.data)
    writes[outPath] = e.data
    if (!quiet) outputLines.push(`  inflating: ${reportPath}`)
  }
  const stdout: ByteSource | null =
    outputLines.length > 0 ? ENC.encode(outputLines.join('\n') + '\n') : null
  if (unmatched.length > 0) {
    return [
      stdout,
      new IOResult({ exitCode: 11, stderr: ENC.encode(cautionText(unmatched)), writes }),
    ]
  }
  return [stdout, new IOResult({ writes })]
}
