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
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { operandsIo, readOperands } from '../utils/operands.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

export type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>
export type Hasher = (bytes: Uint8Array) => Promise<string>

async function hashStream(source: AsyncIterable<Uint8Array>, hasher: Hasher): Promise<string> {
  return hasher(await materialize(source))
}

async function* singleStream(
  source: AsyncIterable<Uint8Array>,
  label: string,
  hasher: Hasher,
  name: string,
  opts: CommandOpts,
): AsyncIterable<Uint8Array> {
  const digest = await hashStream(source, hasher)
  yield ENC.encode(hashLine(digest, label, name, opts))
}

function algorithmName(name: string): string {
  return name.slice(0, -3).toUpperCase()
}

function hashLine(digest: string, label: string, name: string, opts: CommandOpts): string {
  const terminator = opts.flags.z === true || opts.flags.zero === true ? '\0' : '\n'
  if (opts.flags.tag === true) {
    return `${algorithmName(name)} (${label}) = ${digest}${terminator}`
  }
  const marker = opts.flags.b === true || opts.flags.binary === true ? '*' : ' '
  return `${digest} ${marker}${label}${terminator}`
}

function makePathSpec(virtual: string, mountPrefix: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: mountKey(virtual, mountPrefix),
    resolved: true,
  })
}

async function checkFile(
  stream: Stream,
  p: PathSpec,
  hasher: Hasher,
  name: string,
  opts: CommandOpts,
): Promise<[Uint8Array | null, Uint8Array | null, number]> {
  const data = DEC.decode(await materialize(stream(p)))
  const mountPrefix = mountPrefixOf(p.virtual, p.resourcePath)
  const output: string[] = []
  const errors: string[] = []
  let failed = false
  let malformed = 0
  for (const line of data.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseCheckLine(line, name)
    if (parsed === null) {
      malformed += 1
      continue
    }
    const [expected, filename] = parsed
    let digest: string
    try {
      digest = await hashStream(stream(makePathSpec(filename, mountPrefix)), hasher)
    } catch (error) {
      if (opts.flags.ignore_missing === true && isMissingError(error)) continue
      if (opts.flags.status !== true) output.push(`${filename}: FAILED open or read`)
      failed = true
      continue
    }
    if (digest === expected) {
      if (opts.flags.status !== true && opts.flags.quiet !== true) output.push(`${filename}: OK`)
    } else {
      if (opts.flags.status !== true) output.push(`${filename}: FAILED`)
      failed = true
    }
  }
  if (malformed > 0 && (opts.flags.w === true || opts.flags.warn === true)) {
    const count = malformed === 1 ? '1 line is' : `${String(malformed)} lines are`
    errors.push(`WARNING: ${count} improperly formatted`)
  }
  if (malformed > 0 && opts.flags.strict === true) failed = true
  const stdout = output.length > 0 ? ENC.encode(`${output.join('\n')}\n`) : null
  const stderr = errors.length > 0 ? ENC.encode(`${errors.join('\n')}\n`) : null
  return [stdout, stderr, failed ? 1 : 0]
}

function parseCheckLine(line: string, name: string): [string, string] | null {
  const tagged = new RegExp(`^${algorithmName(name)} \\((.*)\\) = ([0-9a-fA-F]+)$`).exec(line)
  if (tagged !== null) return [tagged[2]?.toLowerCase() ?? '', tagged[1] ?? '']
  const match = /^([0-9a-fA-F]+) [ *](.*)$/.exec(line)
  if (match === null) return null
  return [match[1]?.toLowerCase() ?? '', match[2] ?? '']
}

function isMissingError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return (error as { code?: unknown }).code === 'ENOENT'
}

export async function checksumGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: Stream,
  hasher: Hasher,
  name: string,
): Promise<CommandFnResult> {
  const check = opts.flags.c === true || opts.flags.check === true
  if (check && paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    const [out, stderr, exitCode] = await checkFile(stream, first, hasher, name, opts)
    return [out, new IOResult({ stderr, exitCode })]
  }
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the good hashes still
    // print (GNU coreutils checksum commands).
    const [ok, err] = await readOperands(paths, stream, name)
    const io = operandsIo(err, { cache: ok.map((o) => o.path.mountPath) })
    if (ok.length === 0 && err !== '') return [null, io]
    let body = ''
    for (const o of ok) body += hashLine(await hasher(o.data), o.path.rawPath, name, opts)
    const result: ByteSource = ENC.encode(body)
    return [result, io]
  }
  const source: AsyncIterable<Uint8Array> = resolveSource(opts.stdin)
  return [singleStream(source, '-', hasher, name, opts), new IOResult()]
}
