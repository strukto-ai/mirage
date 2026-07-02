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

import type { DatabricksVolumeConfig } from '../../resource/databricks_volume/config.ts'
import { PathSpec } from '../../types.ts'
import { stripSlash, rstripSlash } from '../../utils/slash.ts'

export function normalizePosix(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  const joined = out.join('/')
  if (absolute) return '/' + joined
  return joined === '' ? '.' : joined
}

export function volumeRoot(config: DatabricksVolumeConfig): string {
  return `/Volumes/${config.catalog}/${config.schema}/${config.volume}`
}

function assertInsideRoot(root: string, path: string, message: string): void {
  if (path === root || path.startsWith(root + '/')) return
  throw new Error(message)
}

export function configuredRoot(config: DatabricksVolumeConfig): string {
  const rootRelative = stripSlash(config.rootPath)
  if (rootRelative !== '') {
    return normalizePosix(`${volumeRoot(config)}/${rootRelative}`)
  }
  return normalizePosix(volumeRoot(config))
}

export function backendPath(config: DatabricksVolumeConfig, path: PathSpec | string): string {
  const raw = path instanceof PathSpec ? path.mountPath : path
  const relative = stripSlash(raw)
  const root = configuredRoot(config)
  const remotePath = normalizePosix(relative !== '' ? `${root}/${relative}` : root)
  assertInsideRoot(root, remotePath, `path escapes Databricks volume root: ${raw}`)
  return remotePath
}

export function virtualPath(config: DatabricksVolumeConfig, backend: string, prefix = ''): string {
  const root = configuredRoot(config)
  const remotePath = normalizePosix(backend)
  assertInsideRoot(root, remotePath, `backend path is outside Databricks volume root: ${backend}`)
  const relative = stripSlash(remotePath === root ? '' : remotePath.slice(root.length))
  const path = relative !== '' ? '/' + relative : '/'
  if (prefix !== '' && path !== '/') return rstripSlash(prefix) + path
  return prefix !== '' ? prefix : path
}
