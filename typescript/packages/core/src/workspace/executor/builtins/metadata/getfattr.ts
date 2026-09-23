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
import { classify } from '../../../../errors/index.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { FileStat, FileType, PathSpec, wordText } from '../../../../types.ts'
import { encodeBase64 } from '../../../../utils/base64.ts'
import type { SessionState } from '../../../session/session.ts'
import { result } from '../shared.ts'
import type { Result } from '../types.ts'
import { GETFATTR_USAGE, attrError, attrOperands, attrUsageRefusal } from './xattr.ts'

const ENCODINGS = new Set(['text', 'hex', 'base64'])
const DEFAULT_MATCH = '^user\\.'
const ENC = new TextEncoder()

/**
 * One value the way getfattr prints it after `name=`. With no `-e` the
 * value is text when at most one byte in eight is unprintable (a
 * trailing NUL not counted) and base64 otherwise. Text escapes NUL,
 * newline and carriage return as octal and `"` and `\` with a backslash,
 * and passes every other byte through raw; a trailing NUL is dropped.
 * Mirrors Python's `encode_value`.
 */
export function encodeValue(value: Uint8Array, encoding: string | null): Uint8Array {
  const body = value.at(-1) === 0 ? value.subarray(0, -1) : value
  let chosen = encoding
  if (chosen === null) {
    const unprintable = body.filter((b) => b < 0x20 || b > 0x7e).length
    chosen = body.length >= unprintable * 8 ? 'text' : 'base64'
  }
  if (chosen === 'hex') {
    return ENC.encode('0x' + [...value].map((b) => b.toString(16).padStart(2, '0')).join(''))
  }
  if (chosen === 'base64') return ENC.encode('0s' + encodeBase64(value))
  const out: number[] = [0x22]
  for (const b of body) {
    if (b === 0 || b === 0x0a || b === 0x0d)
      out.push(...ENC.encode('\\' + b.toString(8).padStart(3, '0')))
    else if (b === 0x22 || b === 0x5c) out.push(0x5c, b)
    else out.push(b)
  }
  out.push(0x22)
  return Uint8Array.from(out)
}

/**
 * A subtree in pre-order, the way nftw hands it to getfattr -R. Every
 * entry is reported, links included. A link to a directory is descended
 * only when `deref` says so: for every entry under `-L`, and for an
 * operand itself unless `-P`. Mirrors Python's `_walk`.
 */
async function walk(
  dispatch: DispatchFn,
  path: PathSpec,
  shown: string,
  logical: boolean,
  deref: boolean,
): Promise<[PathSpec, string][]> {
  const entries: [PathSpec, string][] = [[path, shown]]
  let stat: unknown
  try {
    ;[stat] = await dispatch('stat', path, [], { nofollow: true })
    if (stat instanceof FileStat && stat.type === FileType.SYMLINK && deref) {
      ;[stat] = await dispatch('stat', path)
    }
  } catch (err) {
    if (classify(err) === 'ENOENT') return entries
    throw err
  }
  if (!(stat instanceof FileStat) || stat.type !== FileType.DIRECTORY) return entries
  const [children] = (await dispatch('readdir', path)) as [string[], unknown]
  for (const child of children) {
    const bare = child.replace(/\/+$/, '')
    const name = bare.slice(bare.lastIndexOf('/') + 1)
    const below = `${shown.replace(/\/+$/, '')}/${name}`
    entries.push(...(await walk(dispatch, PathSpec.fromStrPath(bare), below, logical, logical)))
  }
  return entries
}

interface Wanted {
  name: string | null
  matcher: RegExp | null
  dump: boolean
  onlyValues: boolean
  encoding: string | null
  nofollow: boolean
}

/**
 * One path's output (its `# file:` block, or its bare values), and
 * whether an attribute it was asked for is not set. An attribute that is
 * not set is reported per name and skipped; any other failure (the path
 * is missing) is the caller's to report. Mirrors Python's `_file_block`.
 */
async function fileBlock(
  dispatch: DispatchFn,
  path: PathSpec,
  label: string,
  header: string,
  want: Wanted,
  errors: string[],
): Promise<[Uint8Array, boolean]> {
  let names: string[]
  if (want.name !== null) {
    names = [want.name]
  } else {
    const [listed] = (await dispatch('listxattr', path, [], { nofollow: want.nofollow })) as [
      string[],
      unknown,
    ]
    names = listed.filter((n) => want.matcher === null || want.matcher.test(n))
  }
  const out: number[] = []
  const block: number[] = []
  let missing = false
  for (const attr of names) {
    if (!want.dump && !want.onlyValues) {
      block.push(...ENC.encode(`${attr}\n`))
      continue
    }
    let value: Uint8Array
    try {
      ;[value] = (await dispatch('getxattr', path, [], {
        name: attr,
        nofollow: want.nofollow,
      })) as [Uint8Array, unknown]
    } catch (err) {
      if (classify(err) !== 'NO_XATTR') throw err
      errors.push(`${label}: ${attr}: ${attrError(err)}\n`)
      missing = true
      continue
    }
    if (want.onlyValues) out.push(...value)
    else block.push(...ENC.encode(`${attr}=`), ...encodeValue(value, want.encoding), 0x0a)
  }
  if (block.length > 0) out.push(...ENC.encode(`# file: ${header}\n`), ...block, 0x0a)
  return [Uint8Array.from(out), missing]
}

/**
 * getfattr: print the extended attributes of each path.
 *
 * Debian's attr 2.5.2, pinned in docker: a `# file:` block per path that
 * has a matching attribute, names sorted, a blank line after each block,
 * `-d`/`-n` adding `="value"`, and the default match `^user\.` (`-m -`
 * matches every name). The attributes are the op door's: what was set on
 * the path. `-h` reads a link's own attributes. Mirrors Python's
 * `handle_getfattr`.
 */
export async function handleGetfattr(
  dispatch: DispatchFn,
  session: SessionState,
  args: (string | PathSpec)[],
): Promise<Result> {
  const spec = specOf('getfattr')
  const parsed = parseCommand(
    spec,
    args.map((a) => wordText(a)),
    session.cwd,
    'getfattr',
  )
  const refused = attrUsageRefusal('getfattr', parsed, GETFATTR_USAGE)
  if (refused !== null) return refused
  const fl = new FlagView(parseToKwargs(parsed), spec)
  const encoding = fl.asStr('encoding') ?? null
  const targets = attrOperands(parsed)
  if ((encoding !== null && !ENCODINGS.has(encoding)) || targets.length === 0) {
    return result('getfattr', { exitCode: 2, stderr: GETFATTR_USAGE })
  }
  const pattern = fl.asStr('match') ?? DEFAULT_MATCH
  let matcher: RegExp | null = null
  if (pattern !== '-') {
    try {
      matcher = new RegExp(pattern)
    } catch {
      return result('getfattr', {
        exitCode: 1,
        stderr: `getfattr: invalid regular expression "${pattern}"\n`,
      })
    }
  }
  const name = fl.asStr('name') ?? null
  const want: Wanted = {
    name,
    matcher,
    dump: fl.asBool('dump') || name !== null,
    onlyValues: fl.asBool('only_values'),
    encoding,
    nofollow: fl.asBool('no_dereference'),
  }
  const absolute = fl.asBool('absolute_names')
  const out: number[] = []
  const errors: string[] = []
  let failed = false
  let warned = false
  for (const target of targets) {
    const typed = target.rawPath
    const entries = fl.asBool('recursive')
      ? await walk(dispatch, target, typed, fl.asBool('logical'), !fl.asBool('physical'))
      : ([[target, typed]] as [PathSpec, string][])
    for (const [path, label] of entries) {
      const header = !absolute && label.startsWith('/') ? label.replace(/^\/+/, '') || '.' : label
      let block: Uint8Array
      let missing: boolean
      try {
        ;[block, missing] = await fileBlock(dispatch, path, label, header, want, errors)
      } catch (err) {
        errors.push(`getfattr: ${label}: ${attrError(err)}\n`)
        failed = true
        continue
      }
      if (block.length > 0 && header !== label && !want.onlyValues && !warned) {
        errors.push("getfattr: Removing leading '/' from absolute path names\n")
        warned = true
      }
      out.push(...block)
      failed = failed || missing
    }
  }
  return result('getfattr', {
    out: out.length > 0 ? Uint8Array.from(out) : null,
    exitCode: failed ? 1 : 0,
    stderr: errors.join(''),
  })
}
