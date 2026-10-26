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

import { PathSpec } from '../../types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { TiDBFilesystemConfig } from '../../vfs/tidb_filesystem/config.ts'

export function backendPath(config: TiDBFilesystemConfig, path: PathSpec | string): string {
  const raw = path instanceof PathSpec ? path.mountPath : path
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.includes('..')) throw new Error(`path escapes TiDB file system root: ${raw}`)
  if (parts.length === 0) return config.rootPath
  return `${rstripSlash(config.rootPath)}/${parts.join('/')}`
}
