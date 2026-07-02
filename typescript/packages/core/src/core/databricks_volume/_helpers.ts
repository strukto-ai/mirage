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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { PathSpec } from '../../types.ts'
import { rstripSlash } from '../../utils/slash.ts'

export function ensurePathSpec(path: PathSpec | string): PathSpec {
  if (path instanceof PathSpec) return path
  return PathSpec.fromStrPath(path)
}

export function parentPath(path: PathSpec | string): PathSpec {
  const p = ensurePathSpec(path)
  const prefix = mountPrefixOf(p.virtual, p.resourcePath)
  const stripped = rstripSlash(p.mountPath)
  let parentRelative = stripped.includes('/') ? stripped.slice(0, stripped.lastIndexOf('/')) : '/'
  if (!parentRelative.startsWith('/')) parentRelative = '/' + parentRelative
  let virtual: string
  if (prefix !== '') {
    virtual = rstripSlash(prefix)
    if (parentRelative !== '/') virtual += parentRelative
  } else {
    virtual = parentRelative
  }
  const full = virtual !== '' ? virtual : '/'
  return PathSpec.fromStrPath(full, mountKey(full, prefix))
}
