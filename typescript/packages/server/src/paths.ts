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

import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { ENV_HOME, ENV_PID_FILE } from './env.ts'

export class PathOutsideRootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathOutsideRootError'
  }
}

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

export function mirageHome(env: Record<string, string | undefined> = process.env): string {
  const override = env[ENV_HOME]
  return override !== undefined && override !== '' ? resolve(override) : join(homedir(), '.mirage')
}

export function pidFilePath(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (explicit !== undefined) return resolve(explicit)
  const override = env[ENV_PID_FILE]
  if (override !== undefined && override !== '') return resolve(override)
  return join(mirageHome(env), 'daemon.pid')
}

export function defaultVersionRoot(env: Record<string, string | undefined> = process.env): string {
  return join(mirageHome(env), 'repos')
}

export function defaultSnapshotRoot(env: Record<string, string | undefined> = process.env): string {
  return join(mirageHome(env), 'snapshots')
}

export function resolveWithinRoot(root: string, userPath: string): string {
  const resolvedRoot = resolve(root)
  const resolved = resolve(resolvedRoot, userPath)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new PathOutsideRootError(`path escapes the configured root: ${userPath}`)
  }
  return resolved
}

export function validatePathSegment(segment: string): string {
  if (segment === '.' || segment === '..' || !SAFE_SEGMENT_RE.test(segment)) {
    throw new PathOutsideRootError(`invalid path segment: ${segment}`)
  }
  return segment
}
