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

import type { PathSpec } from '@struktoai/mirage-core'
import { lstripSlash, mountPrefixOf, rstripSlash } from '@struktoai/mirage-core'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000

export function stripPrefix(p: PathSpec): string {
  if (
    mountPrefixOf(p.virtual, p.resourcePath) &&
    p.virtual.startsWith(mountPrefixOf(p.virtual, p.resourcePath))
  ) {
    return p.virtual.slice(mountPrefixOf(p.virtual, p.resourcePath).length) || '/'
  }
  return p.virtual
}

export function joinRoot(root: string, rel: string): string {
  const r = rstripSlash(root)
  const stripped = lstripSlash(rel)
  if (stripped === '') return r === '' ? '/' : r
  if (r === '') return `/${stripped}`
  return `${r}/${stripped}`
}

export function isNoSuchFile(err: unknown): boolean {
  if (err === null || err === undefined) return false
  if (typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 2
}

export function isDirectoryAttrs(attrs: { mode?: number }): boolean {
  if (attrs.mode === undefined) return false
  return (attrs.mode & S_IFMT) === S_IFDIR
}

export function isFileAttrs(attrs: { mode?: number }): boolean {
  if (attrs.mode === undefined) return false
  return (attrs.mode & S_IFMT) === S_IFREG
}
