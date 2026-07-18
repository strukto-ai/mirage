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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathSpec, type RegisteredOp } from '@struktoai/mirage-core'
import { DiskAccessor } from './accessor/disk.ts'

export function tmpRoot(label = 'mirage-disk-test-'): {
  root: string
  accessor: DiskAccessor
  cleanup: () => void
} {
  const root = mkdtempSync(join(tmpdir(), label))
  return {
    root,
    accessor: new DiskAccessor(root),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

export function opOf(
  ops: readonly RegisteredOp[],
  name: string,
  filetype: string | null = null,
): RegisteredOp {
  const found = ops.find((op) => op.name === name && op.filetype === filetype)
  if (found === undefined) throw new Error(`op not registered: ${name}`)
  return found
}
