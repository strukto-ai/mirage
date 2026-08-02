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

import type { PathSpec } from '../../../types.ts'
import { type MountRegistry } from '../../mount/registry.ts'

interface GuardResult {
  message: string
  exitCode: number
}

/**
 * Spot mkdir's -p/--parents by raw token scan. The guard fires before
 * `parseFlags` runs (its refusals must win over parse errors and stay
 * consistent across the single-mount and cross-mount paths), so the
 * shorthand cluster (-pv) is detected on the raw argv rather than
 * through the spec parser.
 */
function hasParentsFlag(argv: readonly string[]): boolean {
  for (const tok of argv) {
    if (tok === '-p' || tok === '--parents') return true
    if (tok.startsWith('-') && !tok.startsWith('--') && tok.includes('p')) return true
  }
  return false
}

export function checkMountRootGuard(
  cmdName: string,
  paths: readonly PathSpec[],
  registry: MountRegistry,
  argv: readonly string[],
): GuardResult | null {
  if (paths.length === 0) return null
  const isRoot = (p: PathSpec): boolean => registry.isMountRoot(p.virtual)

  if (cmdName === 'rm' || cmdName === 'rmdir') {
    for (const p of paths) {
      if (isRoot(p)) {
        return {
          message:
            cmdName === 'rmdir'
              ? `rmdir: failed to remove '${p.virtual}': Device or resource busy\n`
              : `rm: cannot remove '${p.virtual}': Device or resource busy\n`,
          exitCode: 1,
        }
      }
    }
    return null
  }

  if (cmdName === 'mv') {
    if (paths[0] !== undefined && isRoot(paths[0])) {
      const dst = paths[1] !== undefined ? paths[1].virtual : '?'
      return {
        message: `mv: cannot move '${paths[0].virtual}' to '${dst}': Device or resource busy\n`,
        exitCode: 1,
      }
    }
    return null
  }

  if (cmdName === 'mkdir') {
    // GNU mkdir -p makes "already exists" a no-op.
    if (hasParentsFlag(argv)) return null
    for (const p of paths) {
      if (isRoot(p)) {
        return {
          message: `mkdir: cannot create directory '${p.virtual}': File exists\n`,
          exitCode: 1,
        }
      }
    }
    return null
  }

  if (cmdName === 'touch') {
    for (const p of paths) {
      if (isRoot(p)) {
        return {
          message: `touch: cannot touch '${p.virtual}': Is a directory\n`,
          exitCode: 1,
        }
      }
    }
    return null
  }

  if (cmdName === 'ln') {
    const last = paths[paths.length - 1]
    if (last !== undefined && isRoot(last)) {
      return {
        message: `ln: failed to create link '${last.virtual}': File exists\n`,
        exitCode: 1,
      }
    }
    return null
  }

  return null
}
