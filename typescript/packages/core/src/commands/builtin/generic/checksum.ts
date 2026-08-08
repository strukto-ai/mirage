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
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { fsStrerror, isMissingPath, isWalkError } from '../../../utils/errors.ts'
import { resolvePath } from '../../../utils/path.ts'
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
  const fl = new FlagView(opts.flags, specOf(name))
  const terminator = fl.asBool('zero') ? '\0' : '\n'
  if (fl.asBool('tag')) {
    return `${algorithmName(name)} (${label}) = ${digest}${terminator}`
  }
  const marker = fl.asBool('binary') ? '*' : ' '
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

// The recorded name resolves against the command's cwd, exactly like GNU
// resolves it against the process cwd (a relative `f.txt` in the sums
// file names a sibling of wherever `-c` runs, not of the sums file).
function checkTarget(filename: string, cwd: string, mountPrefix: string): PathSpec {
  return makePathSpec(resolvePath(filename, cwd), mountPrefix)
}

function countNoun(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : `${String(count)} ${plural}`
}

async function checkFile(
  stream: Stream,
  p: PathSpec,
  hasher: Hasher,
  name: string,
  opts: CommandOpts,
): Promise<[Uint8Array | null, Uint8Array | null, number]> {
  const fl = new FlagView(opts.flags, specOf(name))
  const data = DEC.decode(await materialize(stream(p)))
  const mountPrefix = mountPrefixOf(p.virtual, p.resourcePath)
  const checkLabel = p.rawPath !== '' ? p.rawPath : p.virtual
  const output: string[] = []
  const errors: string[] = []
  let verified = 0
  let mismatched = 0
  let readFailures = 0
  let malformed = 0
  let lineno = 0
  let parsedAny = false
  for (const line of data.split('\n')) {
    lineno += 1
    if (line.trim() === '') continue
    const parsed = parseCheckLine(line, name)
    if (parsed === null) {
      malformed += 1
      if (fl.asBool('warn')) {
        errors.push(
          `${name}: ${checkLabel}: ${String(lineno)}: improperly formatted ` +
            `${algorithmName(name)} checksum line`,
        )
      }
      continue
    }
    parsedAny = true
    const [expected, filename] = parsed
    let digest: string
    try {
      digest = await hashStream(stream(checkTarget(filename, opts.cwd, mountPrefix)), hasher)
    } catch (error) {
      if (!isWalkError(error)) throw error
      // GNU --ignore-missing skips only absence; a permission or
      // transport-shaped failure still reports and fails the check.
      if (fl.asBool('ignore_missing') && isMissingPath(error)) continue
      const strerror = fsStrerror(error) ?? (error instanceof Error ? error.message : String(error))
      errors.push(`${name}: ${filename}: ${strerror}`)
      if (!fl.asBool('status')) output.push(`${filename}: FAILED open or read`)
      readFailures += 1
      continue
    }
    if (digest === expected) {
      verified += 1
      if (!fl.asBool('status') && !fl.asBool('quiet')) output.push(`${filename}: OK`)
    } else {
      if (!fl.asBool('status')) output.push(`${filename}: FAILED`)
      mismatched += 1
    }
  }
  // GNU's terminal diagnostics and WARNING block, in its order (pinned
  // against coreutils 9.7): a file with no properly formatted line is
  // fatal on its own, even under --status. "No file was verified" means
  // --ignore-missing left zero OK lines — mismatches included — and
  // follows the summaries; --status silences it (and the summaries, but
  // not the per-file strerror lines) while its exit 1 stands.
  if (!parsedAny) {
    errors.push(`${name}: ${checkLabel}: no properly formatted checksum lines found`)
    return [null, ENC.encode(`${errors.join('\n')}\n`), 1]
  }
  const nothingVerified = fl.asBool('ignore_missing') && verified === 0
  if (!fl.asBool('status')) {
    if (malformed > 0) {
      errors.push(
        `${name}: WARNING: ${countNoun(malformed, '1 line is', 'lines are')} improperly formatted`,
      )
    }
    if (readFailures > 0) {
      errors.push(
        `${name}: WARNING: ${countNoun(readFailures, '1 listed file', 'listed files')} could not be read`,
      )
    }
    if (mismatched > 0) {
      errors.push(
        `${name}: WARNING: ${countNoun(mismatched, '1 computed checksum', 'computed checksums')} did NOT match`,
      )
    }
    if (nothingVerified) {
      errors.push(`${name}: ${checkLabel}: no file was verified`)
    }
  }
  const failed =
    mismatched > 0 || readFailures > 0 || nothingVerified || (fl.asBool('strict') && malformed > 0)
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

export async function checksumGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: Stream,
  hasher: Hasher,
  name: string,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf(name))
  const check = fl.asBool('check')
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
