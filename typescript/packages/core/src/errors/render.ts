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

import { READ_FAILURES, STRERROR } from './constants.ts'
import { errorVirtualPath, fsError, gnuStrerror, virtualOf } from './fs.ts'
import { encodeText } from '../shell/bytes.ts'
import { dropTrailingSegments, respellOne } from '../utils/path.ts'
import { quotesOperands, shellQuote, shellQuoteAlways } from '../utils/quote.ts'
import { rstripSlash } from '../utils/slash.ts'

// Re-spell a reported path the way its operand was typed. Backends name paths
// in virtual space, but GNU quotes the operand as the user wrote it:
// `cd /data && mkdir -p f.txt/sub` reports 'f.txt', not '/data/f.txt'. The path
// an error names is the operand itself, an ancestor of it (mkdir -p blames the
// component of the chain it tripped on), or something under it, so all three
// are rebased onto rawPath. An absolute operand rebases to itself, which is why
// this is a no-op for most invocations. Mirrors Python's operand_spelling.
export function operandSpelling(
  path: string,
  operand: { virtual: string; rawPath?: string },
): string {
  const virtual = operand.virtual
  const raw = operand.rawPath ?? virtual
  if (raw === virtual) return path
  if (path === virtual) return raw
  const base = rstripSlash(virtual)
  if (path.startsWith(base + '/')) return respellOne(path, virtual, raw)
  const trimmed = rstripSlash(path)
  if (base.startsWith(trimmed + '/')) {
    const segments = (p: string): number => p.split('/').filter((s) => s !== '').length
    return dropTrailingSegments(raw, segments(base) - segments(trimmed))
  }
  return path
}

const CANNOT_OPEN = 'cannot open {quoted} for reading: {strerror}'

// How GNU words a failed operand for the commands that name the step that
// failed instead of printing `<cmd>: <name>: <strerror>`. An entry is
// [opening, reading]: the line for a name the command could not open, and
// for one it opened that then refused the read (READ_FAILURES). null keeps
// the plain line for that step, which is also the choice wherever GNU's own
// line drops the name (`base64: read error`, `fmt: read error`): mirage
// words a step GNU's way only while that still says which operand failed.
// `{quoted}` is the name always quoted (gnulib's quoteaf), `{shown}` quoted
// only when it needs it (quotef), `{bare}` as typed. Measured on coreutils
// 9.7 and GNU sed 4.9 (debian:stable-slim), a directory read on tmpfs:
// overlayfs answers a directory's read with EINVAL, so a tac there says
// `read error: Invalid argument`. Mirrors Python's FAILURE_WORDING.
export const FAILURE_WORDING: ReadonlyMap<string, readonly [string | null, string | null]> =
  new Map([
    ['csplit', [CANNOT_OPEN, null]],
    ['du', ['cannot access {quoted}: {strerror}', null]],
    ['find', ['{quoted}: {strerror}', '{quoted}: {strerror}']],
    ['fmt', [CANNOT_OPEN, null]],
    ['head', [CANNOT_OPEN, 'error reading {quoted}: {strerror}']],
    ['ls', ['cannot access {quoted}: {strerror}', null]],
    [
      'mkdir',
      [
        'cannot create directory {quoted}: {strerror}',
        'cannot create directory {quoted}: {strerror}',
      ],
    ],
    ['rev', ['cannot open {bare}: {strerror}', null]],
    ['rm', ['cannot remove {quoted}: {strerror}', 'cannot remove {quoted}: {strerror}']],
    ['rmdir', ['failed to remove {quoted}: {strerror}', 'failed to remove {quoted}: {strerror}']],
    ['sed', ["can't read {bare}: {strerror}", 'read error on {bare}: {strerror}']],
    ['split', [CANNOT_OPEN, null]],
    ['stat', ['cannot statx {quoted}: {strerror}', 'cannot statx {quoted}: {strerror}']],
    ['tac', ['failed to open {quoted} for reading: {strerror}', '{shown}: read error: {strerror}']],
    ['tail', [CANNOT_OPEN, 'error reading {quoted}: {strerror}']],
    ['touch', ['cannot touch {quoted}: {strerror}', 'cannot touch {quoted}: {strerror}']],
    [
      'truncate',
      [
        'cannot open {quoted} for writing: {strerror}',
        'cannot open {quoted} for writing: {strerror}',
      ],
    ],
    ['tsort', [null, '{shown}: read error: {strerror}']],
    ['uniq', [null, 'error reading {quoted}: {strerror}']],
  ])

// The command's own template for this failure, null for the plain line: no
// entry, no template for the step, or standard input, whose `-` line is the
// one GNU prints when it closes a stdin it could not read.
// GNU wc and du vet every name the way their --files0-from reader does,
// and refuse an empty one in these words before any open could answer
// ENOENT for it (coreutils 9.7). Mirrors Python's ZERO_LENGTH_NAME.
export const ZERO_LENGTH_NAME = 'invalid zero-length file name'

const VETS_EMPTY_NAMES: ReadonlySet<string> = new Set(['du', 'wc'])

function stepWording(cmdName: string, label: string, code: string | undefined): string | null {
  const wording = FAILURE_WORDING.get(cmdName)
  if (wording === undefined || label === '-') return null
  return code !== undefined && READ_FAILURES.has(code) ? wording[1] : wording[0]
}

// GNU coreutils stderr line for one failed path operand, spelled as typed
// (PathSpec.rawPath). Byte-identical with the executor chokepoint and the
// Python fs_error_line. Used by read-family commands that keep processing
// remaining operands after one fails, where the caller holds the operand.
// A command in SHELL_QUOTED_COMMANDS reports the operand shell-quoted when
// it needs it ('*.txt'), the way GNU does; every other command reports it
// bare. A command in FAILURE_WORDING says which step failed instead.
export function fsErrorLine(
  cmdName: string,
  path: string | { virtual: string; rawPath?: string },
  err: unknown,
): string {
  const code = (err as { code?: string }).code
  const typed = virtualOf(path)
  if (typed === '' && VETS_EMPTY_NAMES.has(cmdName)) return `${cmdName}: ${ZERO_LENGTH_NAME}\n`
  const strerror = gnuStrerror(code)
  const template = stepWording(cmdName, typed, code)
  if (template !== null && strerror !== null) {
    // One pass, so a name that spells a placeholder is never substituted.
    const values: Record<string, string> = {
      quoted: shellQuoteAlways(typed),
      shown: shellQuote(typed),
      bare: typed,
      strerror,
    }
    const line = template.replace(/\{(quoted|shown|bare|strerror)\}/g, (_, key: string) => {
      return values[key] ?? ''
    })
    return `${cmdName}: ${line}\n`
  }
  const label = quotesOperands(cmdName) ? shellQuote(typed) : typed
  if (strerror !== null) return `${cmdName}: ${label}: ${strerror}\n`
  return `${cmdName}: ${label}\n`
}

// Re-say another command's failed-operand line in `cmdName`'s voice. A
// command that reads its operands through another one (the cross-mount
// stream strategy fetches each with cat) holds that command's rendered
// line, not the error. When the line is the fetch command's own
// fsErrorLine for `operand`, it is rendered again from the strerror it
// names, so the prefix, the quoting and the step wording are all the real
// command's; any other line only has its prefix swapped. Mirrors Python's
// revoice_fs_error_line.
export function revoiceFsErrorLine(
  line: string,
  fromCmd: string,
  cmdName: string,
  operand: string | { virtual: string; rawPath?: string },
): string {
  const prefix = `${fromCmd}: `
  if (!line.startsWith(prefix)) return line
  const strerror = line.slice(line.lastIndexOf(': ') + 2)
  const code = Object.keys(STRERROR).find((key) => STRERROR[key] === strerror)
  if (code !== undefined) {
    const err = fsError(operand, code)
    if (fsErrorLine(fromCmd, operand, err) === `${line}\n`) {
      return fsErrorLine(cmdName, operand, err).replace(/\n$/, '')
    }
  }
  return `${cmdName}: ${line.slice(prefix.length)}`
}

// The chokepoint variant of fsErrorLine for callers that only hold the
// error, byte-identical with Python's format_fs_error: the path is
// recovered from the error and, when `paths` is supplied, rewritten to the
// as-typed spelling (PathSpec.rawPath) so a relative argument is reported
// as typed, like GNU. Shared by the single-mount and cross-mount
// chokepoints; takes a structural shape to avoid importing PathSpec (no
// import cycle).
export function formatFsError(
  cmdName: string,
  err: unknown,
  paths?: readonly { virtual: string; rawPath: string }[],
): Uint8Array {
  const strerror = gnuStrerror((err as { code?: string }).code)
  const vpath = errorVirtualPath(err)
  const spelled = paths?.find((p) => p.virtual === vpath)?.rawPath ?? vpath
  let line: string
  if (strerror !== null) {
    line = fsErrorLine(cmdName, spelled, err)
  } else {
    // A message that already carries the `<cmd>: ` prefix (many generic
    // commands throw a fully GNU-formatted string, e.g. `uniq: invalid
    // count`) is emitted verbatim so the prefix is not doubled.
    const message = err instanceof Error ? err.message : String(err)
    line = message.startsWith(`${cmdName}: `) ? `${message}\n` : `${cmdName}: ${message}\n`
  }
  return encodeText(line)
}
