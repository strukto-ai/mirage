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

import { type PathSpec, record, ResourceName } from '@struktoai/mirage-core'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { resolveFileHandle, toWritableChunk } from './utils.ts'

export async function appendBytes(
  accessor: OPFSAccessor,
  p: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const root = accessor.rootHandle
  const start = performance.now()
  const virtual = p.mountPath
  const handle = await resolveFileHandle(root, virtual, { create: true })
  const existing = await handle.getFile()
  const existingBytes = new Uint8Array(await existing.arrayBuffer())
  const merged = new Uint8Array(existingBytes.byteLength + data.byteLength)
  merged.set(existingBytes, 0)
  merged.set(data, existingBytes.byteLength)
  const writable = await handle.createWritable()
  await writable.write(toWritableChunk(merged))
  await writable.close()
  record('append', virtual, ResourceName.OPFS, data.byteLength, start)
}
