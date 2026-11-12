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

import { specOf } from '../../../../commands/spec/builtins.ts'
import { FlagView } from '../../../../commands/spec/flag_view.ts'
import { parseCommand, parseToKwargs } from '../../../../commands/spec/parser.ts'
import { readStdinAsync } from '../../../../commands/builtin/utils/stream.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { isEisdir } from '../../../../errors/fs.ts'
import { type ByteSource, materialize } from '../../../../io/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { decodeText, encodeText } from '../../../../shell/bytes.ts'
import { PathSpec, wordText } from '../../../../types.ts'
import { decodeBase64 } from '../../../../utils/base64.ts'
import type { SessionState } from '../../../session/session.ts'
import { finish, result } from '../shared.ts'
import { attrError, attrOperands, attrUsageRefusal, SETFATTR_USAGE } from './xattr.ts'

/**
 * A `-v` value as setfattr stores it, or null when it is malformed. `0x`
 * is hex and `0s` base64, whitespace ignored. Anything else is text:
 * surrounding double quotes are dropped when both ends have one, and
 * `\ooo`, `\\` and `\"` are decoded while any other backslash stays as
 * typed. Mirrors Python's `decode_value`.
 */
export function decodeValue(text: string): Uint8Array | null {
  const kind = text.length > 2 && text.startsWith('0') ? (text[1] ?? '').toLowerCase() : ''
  if (kind === 'x') {
    const digits = text.slice(2).replace(/\s/g, '')
    if (digits.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(digits)) return null
    return Uint8Array.from(digits.match(/../g) ?? [], (pair) => parseInt(pair, 16))
  }
  if (kind === 's') {
    const digits = text.slice(2).replace(/\s/g, '')
    if (digits.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(digits)) return null
    return decodeBase64(digits)
  }
  let raw = encodeText(text)
  if (raw.length >= 2 && raw[0] === 0x22 && raw[raw.length - 1] === 0x22) {
    raw = raw.subarray(1, -1)
  }
  const out: number[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const byte = raw[i] ?? 0
    if (byte === 0x5c) {
      const digits = raw.subarray(i + 1, i + 4)
      if (digits.length === 3 && digits.every((b) => b >= 0x30 && b <= 0x37)) {
        out.push(parseInt(decodeText(digits), 8) & 0xff)
        i += 3
        continue
      }
      const next = raw[i + 1]
      if (next === 0x5c || next === 0x22) {
        out.push(next)
        i += 1
        continue
      }
    }
    out.push(byte)
  }
  return Uint8Array.from(out)
}

/**
 * A `# file:` name as getfattr escaped it: `\ooo` is that byte and `\\` a
 * backslash. Mirrors Python's `_unescaped`.
 */
function unescaped(name: string): string {
  const raw = encodeText(name)
  const out: number[] = []
  for (let i = 0; i < raw.length;) {
    const digits = raw.subarray(i + 1, i + 4)
    if (raw[i] === 0x5c && digits.length === 3 && digits.every((b) => b >= 0x30 && b <= 0x37)) {
      out.push(parseInt(decodeText(digits), 8) & 0xff)
      i += 4
    } else if (raw[i] === 0x5c && raw[i + 1] === 0x5c) {
      out.push(0x5c)
      i += 2
    } else {
      out.push(raw[i] ?? 0)
      i += 1
    }
  }
  return decodeText(Uint8Array.from(out))
}

/**
 * `--restore`: set what a `getfattr --dump` listing names. Each `# file:`
 * line names the file the attribute lines after it are set on, `NAME=VALUE`
 * decoded as `-v` decodes it (`--raw` leaves it) and a bare `NAME` the empty
 * value; blank lines and other comments are skipped. A listing that cannot be
 * opened is reported with exit 0, as attr 2.5.2 does. Divergence: a failed
 * attribute is reported once and the rest of the listing still restores,
 * where attr repeats the failure and stops. Mirrors Python's `_restore`.
 */
async function restore(
  dispatch: DispatchFn,
  session: SessionState,
  typed: string,
  stdin: ByteSource | null,
  raw: boolean,
  nofollow: boolean,
): Promise<RedirectResult> {
  let data: Uint8Array
  try {
    if (typed === '-') {
      data = (await readStdinAsync(stdin)) ?? new Uint8Array()
    } else {
      const [found] = await dispatch('read', PathSpec.fromStrPath(typed, undefined, session.cwd))
      data =
        found === null || found === undefined
          ? new Uint8Array()
          : await materialize(found as ByteSource)
    }
  } catch (err) {
    return result('setfattr', {
      exitCode: isEisdir(err) ? 1 : 0,
      stderr: `setfattr: ${typed}: ${attrError(err)}\n`,
    })
  }
  const errors: string[] = []
  let target: PathSpec | null = null
  for (const line of decodeText(data).split('\n')) {
    if (line.startsWith('# file: ')) {
      target = PathSpec.fromStrPath(
        unescaped(line.slice('# file: '.length)),
        undefined,
        session.cwd,
      )
      continue
    }
    if (line === '' || line.startsWith('#')) continue
    if (target === null) {
      errors.push(`setfattr: ${typed}: No filename found in line 0, aborting\n`)
      break
    }
    const at = line.indexOf('=')
    const name = at < 0 ? line : line.slice(0, at)
    const text = at < 0 ? '' : line.slice(at + 1)
    const value = raw ? encodeText(text) : decodeValue(text)
    if (value === null) {
      errors.push('bad input encoding\n')
      continue
    }
    try {
      await dispatch('setxattr', target, [], { name, value, nofollow })
    } catch (err) {
      errors.push(`setfattr: ${target.rawPath}: ${attrError(err)}\n`)
    }
  }
  return finish('setfattr', errors)
}

/**
 * setfattr: set or remove one extended attribute on each path.
 *
 * Debian's attr 2.5.2, pinned in docker: `-n NAME [-v VALUE]` sets it (no
 * `-v` is the empty value) and `-x NAME` removes it; exactly one of the
 * two, with `-v` only beside `-n`, or the usage block and exit 2. A
 * malformed hex or base64 value is `bad input encoding`, exit 1. A
 * failure on one path is reported and the rest are still written. The
 * attribute lands on the dispatcher's node table, which takes any name on
 * any path (a link's own with `-h`), as macOS does; linux refuses a name
 * outside its namespaces and a user attribute on a link. Mirrors
 * Python's `handle_setfattr`.
 */
export async function handleSetfattr(
  dispatch: DispatchFn,
  session: SessionState,
  args: (string | PathSpec)[],
  stdin: ByteSource | null = null,
): Promise<RedirectResult> {
  const spec = specOf('setfattr')
  const parsed = parseCommand(
    spec,
    args.map((a) => wordText(a)),
    session.cwd,
    'setfattr',
  )
  const refused = attrUsageRefusal('setfattr', parsed, SETFATTR_USAGE)
  if (refused !== null) return refused
  const fl = new FlagView(parseToKwargs(parsed), spec)
  const raw = fl.asBool('raw')
  const nofollow = fl.asBool('no_dereference')
  const typedRestore = fl.asStr('restore')
  if (typedRestore !== undefined) {
    return restore(dispatch, session, typedRestore, stdin, raw, nofollow)
  }
  const name = fl.asStr('name') ?? null
  const remove = fl.asStr('remove') ?? null
  const typed = fl.asStr('value') ?? null
  const targets = attrOperands(parsed)
  if (
    (name === null) === (remove === null) ||
    (remove !== null && typed !== null) ||
    targets.length === 0
  ) {
    return result('setfattr', { exitCode: 2, stderr: SETFATTR_USAGE })
  }
  const value = typed === null ? new Uint8Array() : raw ? encodeText(typed) : decodeValue(typed)
  if (value === null) return result('setfattr', { exitCode: 1, stderr: 'bad input encoding\n' })
  const errors: string[] = []
  for (const target of targets) {
    try {
      if (name !== null) {
        await dispatch('setxattr', target, [], { name, value, nofollow })
      } else {
        await dispatch('removexattr', target, [], { name: remove, nofollow })
      }
    } catch (err) {
      errors.push(`setfattr: ${target.rawPath}: ${attrError(err)}\n`)
    }
  }
  return finish('setfattr', errors)
}
