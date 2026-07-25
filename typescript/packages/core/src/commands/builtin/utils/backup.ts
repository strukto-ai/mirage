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
import { PathSpec, type ReaddirFn } from '../../../types.ts'
import { rekey } from '../../../utils/key_prefix.ts'
import { rstripSlash } from '../../../utils/slash.ts'

// GNU version-control names (each canonical control has a legacy alias).
const BACKUP_CONTROLS: Readonly<Record<string, string>> = Object.freeze({
  none: 'none',
  off: 'none',
  simple: 'simple',
  never: 'simple',
  existing: 'existing',
  nil: 'existing',
  numbered: 'numbered',
  t: 'numbered',
})

export const DEFAULT_BACKUP_SUFFIX = '~'

const NUMBERED_SUFFIX = /^\.~(\d+)~$/

// Resolve -b/--backup[=CONTROL]/-S into a backup control. Deliberate
// divergence from GNU: the VERSION_CONTROL and SIMPLE_BACKUP_SUFFIX
// environment variables are not consulted; the default control is GNU's
// env-less default, 'existing'. A bare -S SUFFIX enables backups on its
// own, matching GNU 9.7. Returns the canonical control
// ('none'/'simple'/'existing'/'numbered'), or null when backups are not
// requested.
export function backupControl(
  cmdName: string,
  value: string | boolean | undefined,
  suffix: string | null,
): string | null {
  const enabled = value !== undefined && value !== false
  if (!enabled && suffix === null) return null
  if (typeof value === 'string') {
    const control = BACKUP_CONTROLS[value]
    if (control === undefined) {
      throw new UsageError(
        `${cmdName}: invalid argument '${value}' for 'backup type'\n` +
          'Valid arguments are:\n' +
          "  - 'none', 'off'\n" +
          "  - 'simple', 'never'\n" +
          "  - 'existing', 'nil'\n" +
          "  - 'numbered', 't'\n" +
          `Try '${cmdName} --help' for more information.`,
        1,
      )
    }
    return control
  }
  return 'existing'
}

// A path next to `path` whose name carries an appended suffix (e.g. '~').
export function siblingPath(path: PathSpec, appended: string): PathSpec {
  const virtual = rstripSlash(path.virtual) + appended
  return PathSpec.fromStrPath(virtual, rekey(path.virtual, path.resourcePath, virtual))
}

// The directory containing `path` on the same mount.
export function parentPath(path: PathSpec): PathSpec {
  const strippedVirtual = rstripSlash(path.virtual)
  const virtual = strippedVirtual.slice(0, strippedVirtual.lastIndexOf('/')) || '/'
  const strippedResource = rstripSlash(path.resourcePath)
  const resource = strippedResource.includes('/')
    ? strippedResource.slice(0, strippedResource.lastIndexOf('/'))
    : ''
  return PathSpec.fromStrPath(virtual, resource)
}

// Existing numbered-backup versions (`name.~N~`) next to a target. A missing
// lister reads as no numbered backups; a failing listing propagates, because
// reading it as "none" would pick `.~1~` (or fall back to the simple suffix)
// and silently overwrite backup history that may exist.
async function numberedVersions(
  readdir: ReaddirFn | undefined,
  target: PathSpec,
): Promise<number[]> {
  if (readdir === undefined) return []
  const base = rstripSlash(target.virtual).split('/').pop() ?? ''
  const children = await readdir(parentPath(target))
  const versions: number[] = []
  for (const child of children) {
    const name = rstripSlash(child).split('/').pop() ?? ''
    if (!name.startsWith(base)) continue
    const match = NUMBERED_SUFFIX.exec(name.slice(base.length))
    if (match !== null) versions.push(Number(match[1]))
  }
  return versions
}

// Pick the backup path for a target about to be overwritten. GNU naming:
// 'simple' appends the suffix, 'numbered' appends `.~N~` one past the
// highest existing version, and 'existing' stays numbered while any
// numbered backup exists and is simple otherwise.
export async function backupTarget(
  readdir: ReaddirFn | undefined,
  target: PathSpec,
  control: string,
  suffix: string,
): Promise<PathSpec | null> {
  if (control === 'none') return null
  if (control === 'simple') return siblingPath(target, suffix)
  const versions = await numberedVersions(readdir, target)
  if (control === 'numbered' || versions.length > 0) {
    return siblingPath(target, `.~${String(Math.max(0, ...versions) + 1)}~`)
  }
  return siblingPath(target, suffix)
}
