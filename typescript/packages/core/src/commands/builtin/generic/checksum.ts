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

import { runStream } from '../../../rs/stream.ts'
import { UsageError } from '../../errors.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { usageExitCode, usageHint } from '../../spec/usage.ts'
import { quoteText } from '../../quote.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { fsStrerror, isEisdir, isFsError, isMissingPath, isWalkError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { resolvePath } from '../../../utils/path.ts'
import { STDIN_HEADER_NAME, STDIN_OPERAND } from '../utils/constants.ts'
import { isStdin, stdinStream } from '../utils/stream.ts'
import { callerStream } from '../generic_bind/dispatch.ts'
import { currentCaller } from '../../../context/session_context.ts'
import { concat } from '../../../utils/bytes.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { mountRoot } from '../utils/links.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

export type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>
// The mount's stored digest of a file for an algorithm, or null to read it.
export type StoredDigest = (p: PathSpec, algorithm: string) => Promise<string | null>

interface ChecksumFlags {
  readonly algorithm: string
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

const BLAKE2B = 'blake2b'

// The *sum command that computes `algorithm`, a hashlib name or `blake2b-N`
// for BLAKE2b at N bits.
function prog(algorithm: string): string {
  return algorithm.startsWith(BLAKE2B) ? 'b2sum' : `${algorithm}sum`
}

// The digest's BSD-style name, as --tag prints it and -c reads it: `SHA256`,
// `BLAKE2b`, `BLAKE2b-256`.
function tag(algorithm: string): string {
  return algorithm.startsWith(BLAKE2B)
    ? `BLAKE2b${algorithm.slice(BLAKE2B.length)}`
    : algorithm.toUpperCase()
}

async function hashSource(source: ByteSource, algorithm: string): Promise<string> {
  const parts: Uint8Array[] = []
  const [family = algorithm, bits] = algorithm.split('-')
  const config = bits === undefined ? { algorithm } : { algorithm: family, length: Number(bits) }
  for await (const part of runStream('digest', config, source)) parts.push(part)
  return DEC.decode(concat(parts))
}

async function report(io: IOResult, prog: string, path: PathSpec, err: unknown): Promise<void> {
  io.stderr = concat([await materialize(io.stderr), ENC.encode(fsErrorLine(prog, path, err))])
  io.exitCode = 1
}

/**
 * One line per operand, its digest asked of `stored` (once `stat` has found a
 * file there) before the file is read; one that fails is reported and the
 * rest still print. `read` opens an operand now, inside the command's cache
 * scope. Mirrors Python's hash_operands.
 */
export async function hashOperands(
  paths: readonly PathSpec[],
  read: Stream,
  algorithm: string,
  prog: string,
  render: (digest: string, label: string) => string,
  stat?: (p: PathSpec) => Promise<unknown>,
  stored?: StoredDigest,
): Promise<[AsyncIterable<Uint8Array>, IOResult]> {
  const io = new IOResult()
  const pending: [PathSpec, string | null, ByteSource][] = []
  for (const p of paths) {
    let digest: string | null = null
    try {
      if (stored !== undefined && !isStdin(p)) {
        await stat?.(p)
        digest = await stored(p, algorithm)
      }
    } catch (err) {
      if (!isFsError(err)) throw err
      await report(io, prog, p, err)
      continue
    }
    pending.push([p, digest, digest === null ? read(p) : new Uint8Array()])
  }
  async function* output(): AsyncIterable<Uint8Array> {
    for (const [p, digest, source] of pending) {
      try {
        yield ENC.encode(render(digest ?? (await hashSource(source, algorithm)), p.rawPath))
      } catch (err) {
        if (!isFsError(err)) throw err
        await report(io, prog, p, err)
      }
    }
  }
  return [output(), io]
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
// (coreutils 9.7).
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

// b2sum's digest for its -l, read as GNU reads it in the option loop: a
// decimal count of bits, 0 or past 512 meaning 512 (coreutils 9.7).
function blake2b(fl: FlagView, name: string): string {
  const value = fl.asStr('length')
  if (value === undefined) return BLAKE2B
  const match = /^\s*\+?([0-9]+)$/.exec(value)
  const refusal = `${name}: invalid length: '${quoteText(value)}'`
  if (match === null) throw new UsageError(refusal, 1)
  const bits = Number(match[1])
  if (bits % 8 !== 0) throw new UsageError(`${refusal}\n${name}: length is not a multiple of 8`, 1)
  return bits === 0 || bits >= 512 ? BLAKE2B : `${BLAKE2B}-${String(bits)}`
}

// Parse the shared `*sum` flag set against one command's spec; b2sum adds -l
// to the set.
function parseFlags(bag: Record<string, FlagValue>, name: string): ChecksumFlags {
  const fl = new FlagView(bag, specOf(name))
  const algorithm = name === 'b2sum' ? blake2b(fl, name) : name.slice(0, -3)
  refuseConflicts(fl, name)
  const mode = readMode(fl)
  return {
    algorithm,
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

function hashLine(digest: string, label: string, flags: ChecksumFlags): string {
  const terminator = flags.zero ? '\0' : '\n'
  if (flags.tag) {
    return `${tag(flags.algorithm)} (${label}) = ${digest}${terminator}`
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

// Read a path through the workspace's dispatcher, on whatever mount holds it: a
// checksum list names files anywhere, not on the list's mount. A stdin name
// (`-`, /dev/stdin) reads the command's input through `stream`, on the
// cursor the list itself reads from. Mirrors Python's dispatched_reader.
export function dispatchedReader(dispatch: DispatchFn, stream: Stream): Stream {
  const caller = currentCaller()
  return (path) => (isStdin(path) ? stream(path) : callerStream(dispatch, caller, path))
}

async function checkFile(
  stream: Stream,
  p: PathSpec,
  algorithm: string,
  ctx: Context,
  flags: ChecksumFlags,
): Promise<[string, string, number]> {
  const name = prog(algorithm)
  const data = DEC.decode(await materialize(stream(p)))
  const listed = ctx.vfs !== undefined ? dispatchedReader(ctx.vfs.dispatch, stream) : stream
  // A list read from stdin names files on the mount the command runs on.
  const mountPrefix = isStdin(p) ? mountRoot(ctx) : mountPrefixOf(p.virtual, p.vfsPath)
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
    const parsed = parseCheckLine(line, algorithm)
    if (parsed === null) {
      malformed += 1
      if (flags.warn) {
        errors.push(
          `${name}: ${checkLabel}: ${String(lineno)}: improperly formatted ` +
            `${tag(algorithm)} checksum line`,
        )
      }
      continue
    }
    parsedAny = true
    const [expected, filename, named] = parsed
    let digest: string
    try {
      digest = await hashSource(listed(checkTarget(filename, ctx.cwd.virtual, mountPrefix)), named)
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
// algorithm's full length in hex; b2sum's length is the line's own.
const HEX_DIGITS: Readonly<Record<string, number>> = {
  md5: 32,
  sha1: 40,
  sha224: 56,
  sha256: 64,
  sha384: 96,
  sha512: 128,
}

// A check line's [digest, filename], in the GNU default format (`<hex>  NAME`
// / `<hex> *NAME`) or the BSD/--tag one (`TAG (NAME) = <hex>`), matching what
// GNU `*sum --check` auto-detects. `tagPattern` is a regex.
function splitLine(line: string, tagPattern: string): [string, string] | null {
  const tagged = new RegExp(`^${tagPattern} \\((.*)\\) = ([0-9a-fA-F]+)$`).exec(line)
  if (tagged !== null) return [tagged[2] ?? '', tagged[1] ?? '']
  const plain = /^([0-9a-fA-F]+) [ *](.*)$/.exec(line)
  return plain === null ? null : [plain[1] ?? '', plain[2] ?? '']
}

// Split a checksum-file line into [expected, filename, algorithm]. A digest
// must have its algorithm's full length in hex. A BLAKE2b line names its own
// length, in its tag (`BLAKE2b-256`) or by its digest's width, a multiple of
// 8 bits up to 512. Mirrors Python's _parse_check_line.
function parseCheckLine(line: string, algorithm: string): [string, string, string] | null {
  if (algorithm !== BLAKE2B) {
    const split = splitLine(line, algorithm.toUpperCase())
    if (split === null || split[0].length !== HEX_DIGITS[algorithm]) return null
    return [split[0].toLowerCase(), split[1], algorithm]
  }
  const split = splitLine(line, 'BLAKE2b(?:-[0-9]+)?')
  if (split === null) return null
  const [digest, name] = split
  const bits = digest.length * 4
  const named = /^BLAKE2b(?:-([0-9]+))? \(/.exec(line)
  if (named !== null && bits !== Number(named[1] ?? 512)) return null
  if (bits % 8 !== 0 || bits > 512) return null
  return [digest.toLowerCase(), name, bits === 512 ? BLAKE2B : `${BLAKE2B}-${String(bits)}`]
}

/**
 * Run a GNU `*sum` over resolved operands. An operand's digest is asked of
 * `stored` first, the one the mount keeps, once `stat` has found a file
 * there, and the file is read only when there is none; a list under `-c` is
 * always verified against the bytes. Mirrors Python's checksum_generic.
 */
export async function checksumGeneric(
  paths: PathSpec[],
  ctx: Context,
  read: Stream,
  name: string,
  stat?: (p: PathSpec) => Promise<unknown>,
  stored?: StoredDigest,
): Promise<CommandFnResult> {
  const parsed = parseFlags(ctx.flags, name)
  const stream = stdinStream(read, ctx.stdin)
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
        checked = await checkFile(stream, p, parsed.algorithm.split('-')[0] ?? '', ctx, parsed)
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
  return hashOperands(
    paths.length > 0 ? paths : [STDIN_OPERAND],
    stream,
    parsed.algorithm,
    name,
    (digest, label) => hashLine(digest, label, parsed),
    stat,
    stored,
  )
}
