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
import { MountMode, PathSpec, WritePolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { DiskAccessor } from './accessor/disk.ts'
import { S3VFS } from './vfs/s3/s3.ts'

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

export function s3Vfs(bucket = 'b'): S3VFS {
  return new S3VFS({ bucket, region: 'us-east-1', accessKeyId: 'fake', secretAccessKey: 'fake' })
}

export function conditionalS3(): Mount {
  return new Mount(s3Vfs(), { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL })
}
