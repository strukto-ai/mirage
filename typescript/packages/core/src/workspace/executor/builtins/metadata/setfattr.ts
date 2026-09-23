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
import type { DispatchFn } from '../../../../runtime/types.ts'
import { type PathSpec, wordText } from '../../../../types.ts'
import { decodeBase64 } from '../../../../utils/base64.ts'
import type { SessionState } from '../../../session/session.ts'
import { finish, result } from '../shared.ts'
import type { Result } from '../types.ts'
import { SETFATTR_USAGE, attrError, attrOperands, attrUsageRefusal } from './xattr.ts'

const HEX = /^[0-9a-fA-F]*$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

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
    if (digits.length % 2 !== 0 || !HEX.test(digits)) return null
    return Uint8Array.from(digits.match(/../g) ?? [], (pair) => parseInt(pair, 16))
  }
  if (kind === 's') {
    const digits = text.slice(2).replace(/\s/g, '')
    if (digits.length % 4 !== 0 || !BASE64.test(digits)) return null
    return decodeBase64(digits)
  }
  let raw = new TextEncoder().encode(text)
  if (raw.length >= 2 && raw[0] === 0x22 && raw[raw.length - 1] === 0x22) {
    raw = raw.subarray(1, -1)
  }
  const out: number[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const byte = raw[i] ?? 0
    if (byte === 0x5c) {
      const digits = raw.subarray(i + 1, i + 4)
      if (digits.length === 3 && digits.every((b) => b >= 0x30 && b <= 0x37)) {
        out.push(parseInt(new TextDecoder().decode(digits), 8) & 0xff)
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
 * setfattr: set or remove one extended attribute on each path.
 *
 * Debian's attr 2.5.2, pinned in docker: `-n NAME [-v VALUE]` sets it (no
 * `-v` is the empty value) and `-x NAME` removes it; exactly one of the
 * two, with `-v` only beside `-n`, or the usage block and exit 2. A
 * malformed hex or base64 value is `bad input encoding`, exit 1. A
 * failure on one path is reported and the rest are still written. The
 * attribute lands on the op door's node table, which takes any name on
 * any path (a link's own with `-h`), as macOS does; linux refuses a name
 * outside its namespaces and a user attribute on a link. Mirrors
 * Python's `handle_setfattr`.
 */
export async function handleSetfattr(
  dispatch: DispatchFn,
  session: SessionState,
  args: (string | PathSpec)[],
): Promise<Result> {
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
  const value = typed !== null ? decodeValue(typed) : new Uint8Array()
  if (value === null) return result('setfattr', { exitCode: 1, stderr: 'bad input encoding\n' })
  const nofollow = fl.asBool('no_dereference')
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
