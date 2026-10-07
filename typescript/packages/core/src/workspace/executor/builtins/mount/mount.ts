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

import { ioContext } from '../../../session/access.ts'

import { usageHint } from '../../../../commands/spec/usage.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { MountMode } from '../../../../types.ts'
import type { PathSpec } from '../../../../types.ts'
import { pathVisible } from '../../../../utils/hidden.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import type { SessionState } from '../../../session/session.ts'
import { fail, ok, parseLine } from '../shared.ts'
import type { Result } from '../types.ts'

// The mount options a mode reads as: the ladder's READ cannot write and only
// EXEC lets the interpreters run a script, which is what ro, rw and noexec say
// about a Linux mount.
const MODE_OPTIONS: Readonly<Record<MountMode, string>> = {
  [MountMode.READ]: 'ro,noexec',
  [MountMode.WRITE]: 'rw,noexec',
  [MountMode.EXEC]: 'rw',
}

// The flags that ask for a mount, which with no operand is a bad usage rather
// than the listing.
const MOUNTING = ['bind', 'move', 'rbind', 'read_only', 'rw']
const BAD_USAGE = `mount: bad usage\n${usageHint('mount')}\n`

function superuser(target: string): string {
  return (
    `mount: ${target}: must be superuser to use mount.\n` +
    '       dmesg(1) may have more information after failed mount system call.\n'
  )
}

/**
 * Whether a filesystem type passes `-t`, libmount's `mnt_match_fstype`. A
 * comma list, case-insensitive; a leading `no` negates the whole list
 * (`-t nofoo,bar` is neither), and a `no` on a later item refuses that one
 * type.
 */
function matchType(name: string, pattern: string): boolean {
  const negated = pattern.startsWith('no')
  const body = negated ? pattern.slice(2) : pattern
  const wanted = name.toLowerCase()
  for (const item of body.split(',')) {
    const lower = item.toLowerCase()
    if (lower.startsWith('no') && lower.slice(2) === wanted) return false
    if (lower === wanted) return !negated
  }
  return negated
}

/**
 * mount [-l] [-t TYPES]: list the mounts the session sees, util-linux 2.41.5's
 * way, with the session's mode as the options (`MODE_OPTIONS`). Mounting is an
 * unprivileged user's refusal, since mounts come from the configuration, a
 * mounting flag with no operand is a bad usage, and `-a` mounts the empty
 * fstab.
 */
export function handleMount(
  registry: MountRegistry,
  session: SessionState,
  args: readonly (string | PathSpec)[],
): Result {
  const [parsed, fl, refused] = parseLine('mount', args, session.cwd)
  if (refused !== null) return refused
  const words = parsed.texts
  const last = words.at(-1)
  if (words.length >= 2 && last !== undefined) return fail('mount', superuser(last), 32)
  const only = words[0]
  if (only !== undefined) return fail('mount', `mount: ${only}: can't find in /etc/fstab.\n`)
  if (fl.asBool('all')) return ok('mount')
  if (fl.asStr('options') !== undefined || MOUNTING.some((dest) => fl.asBool(dest))) {
    return fail('mount', BAD_USAGE)
  }
  const types = fl.asStr('types')
  const lines = [...registry.visibleMounts()]
    .sort((a, b) => compareCodePoints(a.prefix, b.prefix))
    .filter((m) => pathVisible(session.visibility, m.prefix.replace(/\/+$/, '') || '/'))
    .filter((m) => types === undefined || matchType(m.vfs.name, types))
    .map(
      (m) =>
        `${m.vfs.name} on ${m.prefix.replace(/\/+$/, '') || '/'} type ${m.vfs.name} ` +
        `(${MODE_OPTIONS[m.effectiveMode(ioContext(session))]})\n`,
    )
  return ok('mount', lines.length > 0 ? encodeText(lines.join('')) : null)
}
