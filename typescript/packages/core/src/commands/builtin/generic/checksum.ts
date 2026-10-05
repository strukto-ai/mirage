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

import { UsageError } from '../../errors.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { usageExitCode, usageHint } from '../../spec/usage.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { ensureStream } from '../../../io/stream.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { fsStrerror, isEisdir, isMissingPath, isWalkError } from '../../../utils/errors.ts'
import { resolvePath } from '../../../utils/path.ts'
import { STDIN_HEADER_NAME, STDIN_OPERAND } from '../utils/constants.ts'
import { isStdin, resolveSource, stdinStream } from '../utils/stream.ts'
import { operandsIo, readOperands } from '../utils/operands.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

export type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>
export type Hasher = (bytes: Uint8Array) => Promise<string>

interface ChecksumFlags {
  readonly check: boolean
  readonly binary: boolean
  readonly tag: boolean
  readonly zero: boolean
  readonly strict: boolean
  readonly ignoreMissing: boolean
  readonly status: boolean
  readonly quiet: boolean
  readonly warn: boolean
}

async function hashStream(source: AsyncIterable<Uint8Array>, hasher: Hasher): Promise<string> {
  return hasher(await materialize(source))
}

async function* singleStream(
  source: AsyncIterable<Uint8Array>,
  label: string,
  hasher: Hasher,
  name: string,
  flags: ChecksumFlags,
): AsyncIterable<Uint8Array> {
  const digest = await hashStream(source, hasher)
  yield ENC.encode(hashLine(digest, label, name, flags))
}

function algorithmName(name: string): string {
  return name.slice(0, -3).toUpperCase()
}

// The last of -b, -t and --tag (which reads in binary mode), as GNU's option
// loop leaves its one mode.
function readMode(fl: FlagView): string | undefined {
  return fl.typedOrder('binary', 'text', 'tag').at(-1)
}

// The options GNU refuses outside --check, in the order it checks them.
const CHECK_ONLY: readonly (readonly [string, string])[] = [
  ['ignore_missing', '--ignore-missing'],
  ['status', '--status'],
  ['warn', '--warn'],
  ['quiet', '--quiet'],
  ['strict', '--strict'],
]

// Refuse the combinations GNU refuses after its option loop, in its order
// (coreutils 9.7 digest.c).
function refuseConflicts(fl: FlagView, name: string): void {
  const refuse = (message: string): UsageError =>
    new UsageError(`${name}: ${message}\n${usageHint(name)}`, usageExitCode(name))
  const mode = readMode(fl)
  const check = fl.asBool('check')
  const tag = fl.asBool('tag')
  if (tag && mode === 'text') throw refuse('--tag does not support --text mode')
  if (check && fl.asBool('zero')) {
    throw refuse('the --zero option is not supported when verifying checksums')
  }
  if (check && tag) throw refuse('the --tag option is meaningless when verifying checksums')
  if (check && mode !== undefined) {
    throw refuse('the --binary and --text options are meaningless when verifying checksums')
  }
  for (const [flag, word] of CHECK_ONLY) {
    if (!check && fl.asBool(flag)) {
      throw refuse(`the ${word} option is meaningful only when verifying checksums`)
    }
  }
}

// Parse the shared `*sum` flag set against one command's spec; all five
// declare the same set.
function parseFlags(bag: Record<string, FlagValue>, name: string): ChecksumFlags {
  const fl = new FlagView(bag, specOf(name))
  refuseConflicts(fl, name)
  const mode = readMode(fl)
  return {
    check: fl.asBool('check'),
    binary: mode === 'binary' || mode === 'tag',
    tag: fl.asBool('tag'),
    zero: fl.asBool('zero'),
    strict: fl.asBool('strict'),
    ignoreMissing: fl.asBool('ignore_missing'),
    status: fl.asBool('status'),
    quiet: fl.asBool('quiet'),
    warn: fl.asBool('warn'),
  }
}

function hashLine(digest: string, label: string, name: string, flags: ChecksumFlags): string {
  const terminator = flags.zero ? '\0' : '\n'
  if (flags.tag) {
    return `${algorithmName(name)} (${label}) = ${digest}${terminator}`
  }
  const marker = flags.binary ? '*' : ' '
  return `${digest} ${marker}${label}${terminator}`
}

function makePathSpec(virtual: string, mountPrefix: string, rawPath: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: mountKey(virtual, mountPrefix),
    resolved: true,
    rawPath,
  })
}

// The recorded name resolves against the command's cwd, exactly like GNU
// resolves it against the process cwd (a relative `f.txt` in the sums
// file names a sibling of wherever `-c` runs, not of the sums file).
function checkTarget(filename: string, cwd: string, mountPrefix: string): PathSpec {
  return makePathSpec(resolvePath(filename, cwd), mountPrefix, filename)
}

function countNoun(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : `${String(count)} ${plural}`
}

// Read a path through the workspace's door, on whatever mount holds it: a
// checksum list names files anywhere, not on the list's mount. A stdin name
// (`-`, /dev/stdin) reads the command's input through `stream`, on the
// cursor the list itself reads from. Mirrors Python's door_reader.
export function doorReader(dispatch: NonNullable<CommandOpts['dispatch']>, stream: Stream): Stream {
  return async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
    if (isStdin(path)) {
      yield* stream(path)
      return
    }
    const [data] = await dispatch('read', path)
    yield* ensureStream(data as ByteSource)
  }
}

async function checkFile(
  stream: Stream,
  p: PathSpec,
  hasher: Hasher,
  name: string,
  opts: CommandOpts,
  flags: ChecksumFlags,
): Promise<[string, string, number]> {
  const data = DEC.decode(await materialize(stream(p)))
  const listed = opts.dispatch !== undefined ? doorReader(opts.dispatch, stream) : stream
  // A list read from stdin names files on the mount the command runs on.
  const mountPrefix = isStdin(p) ? (opts.mountPrefix ?? '') : mountPrefixOf(p.virtual, p.vfsPath)
  // GNU quotes its stdin name, which holds a space.
  const checkLabel =
    p.rawPath === '-' ? `'${STDIN_HEADER_NAME}'` : p.rawPath !== '' ? p.rawPath : p.virtual
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
      if (flags.warn) {
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
      digest = await hashStream(listed(checkTarget(filename, opts.cwd, mountPrefix)), hasher)
    } catch (error) {
      if (!isWalkError(error)) throw error
      // GNU --ignore-missing skips only absence; a permission or
      // transport-shaped failure still reports and fails the check.
      if (flags.ignoreMissing && isMissingPath(error)) continue
      const strerror = fsStrerror(error) ?? (error instanceof Error ? error.message : String(error))
      errors.push(`${name}: ${filename}: ${strerror}`)
      if (!flags.status) output.push(`${filename}: FAILED open or read`)
      readFailures += 1
      continue
    }
    if (digest === expected) {
      verified += 1
      if (!flags.status && !flags.quiet) output.push(`${filename}: OK`)
    } else {
      if (!flags.status) output.push(`${filename}: FAILED`)
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
    return ['', `${errors.join('\n')}\n`, 1]
  }
  const nothingVerified = flags.ignoreMissing && verified === 0
  if (!flags.status) {
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
    mismatched > 0 || readFailures > 0 || nothingVerified || (flags.strict && malformed > 0)
  const stdout = output.length > 0 ? `${output.join('\n')}\n` : ''
  const stderr = errors.length > 0 ? `${errors.join('\n')}\n` : ''
  return [stdout, stderr, failed ? 1 : 0]
}

// GNU reads a check line as properly formatted only when its digest has the
// algorithm's full length in hex.
const HEX_DIGITS: Readonly<Record<string, number>> = {
  MD5: 32,
  SHA1: 40,
  SHA256: 64,
  SHA384: 96,
  SHA512: 128,
}

function parseCheckLine(line: string, name: string): [string, string] | null {
  const tagged = new RegExp(`^${algorithmName(name)} \\((.*)\\) = ([0-9a-fA-F]+)$`).exec(line)
  const match = tagged ?? /^([0-9a-fA-F]+) [ *](.*)$/.exec(line)
  if (match === null) return null
  const [digest = '', file = ''] = tagged !== null ? [tagged[2], tagged[1]] : [match[1], match[2]]
  if (digest.length !== (HEX_DIGITS[algorithmName(name)] ?? digest.length)) return null
  return [digest.toLowerCase(), file]
}

export async function checksumGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  read: Stream,
  hasher: Hasher,
  name: string,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags, name)
  const stream = stdinStream(read, opts.stdin)
  if (parsed.check) {
    let output = ''
    let errors = ''
    let exitCode = 0
    // Every operand is its own checksum list: GNU verifies each in turn
    // and keeps going when one cannot be read; a directory operand reads
    // as the literal "read error" (pinned on coreutils 9.7). With no
    // operand the checksum list is stdin.
    for (const p of paths.length > 0 ? paths : [STDIN_OPERAND]) {
      let checked: [string, string, number]
      try {
        checked = await checkFile(stream, p, hasher, name, opts, parsed)
      } catch (error) {
        if (!isWalkError(error)) throw error
        const label = p.rawPath !== '' ? p.rawPath : p.virtual
        const detail = isEisdir(error)
          ? 'read error'
          : (fsStrerror(error) ?? (error instanceof Error ? error.message : String(error)))
        errors += `${name}: ${label}: ${detail}\n`
        exitCode = 1
        continue
      }
      output += checked[0]
      errors += checked[1]
      if (checked[2] !== 0) exitCode = 1
    }
    return [
      output === '' ? null : ENC.encode(output),
      new IOResult({ stderr: errors === '' ? null : ENC.encode(errors), exitCode }),
    ]
  }
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the good hashes still
    // print (GNU coreutils checksum commands).
    const [ok, err] = await readOperands(paths, stream, name)
    const io = operandsIo(err, {
      cache: ok.filter((o) => !isStdin(o.path)).map((o) => o.path.mountPath),
    })
    if (ok.length === 0 && err !== '') return [null, io]
    let body = ''
    for (const o of ok) body += hashLine(await hasher(o.data), o.path.rawPath, name, parsed)
    const result: ByteSource = ENC.encode(body)
    return [result, io]
  }
  const source: AsyncIterable<Uint8Array> = resolveSource(opts.stdin)
  return [singleStream(source, '-', hasher, name, parsed), new IOResult()]
}
