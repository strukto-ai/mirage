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
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { isNotFound, resolveParentDirHandle } from './utils.ts'

export async function rmR(accessor: OPFSAccessor, path: PathSpec): Promise<void> {
  const root = accessor.rootHandle
  const virtual = path.mountPath
  let parentDir: FileSystemDirectoryHandle
  let name: string
  try {
    ;[parentDir, name] = await resolveParentDirHandle(root, virtual, { create: false })
  } catch (err) {
    if (isNotFound(err)) return
    if (err instanceof Error && err.message.startsWith('no parent directory')) return
    throw err
  }
  try {
    await parentDir.removeEntry(name, { recursive: true })
  } catch (err) {
    if (isNotFound(err)) return
    throw err
  }
}
