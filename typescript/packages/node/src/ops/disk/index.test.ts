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

import { describe, expect, it } from 'vitest'
import { ResourceName } from '@struktoai/mirage-core'
import {
  appendOp,
  createOp,
  DISK_OPS,
  mkdirOp,
  readdirOp,
  readFeatherOp,
  readHdf5Op,
  readOp,
  readParquetOp,
  renameOp,
  rmdirOp,
  statOp,
  truncateOp,
  unlinkOp,
  writeOp,
} from './index.ts'

describe('DISK_OPS', () => {
  it('registers the expected 15 ops with resource=disk', () => {
    expect(DISK_OPS).toHaveLength(15)
    for (const op of DISK_OPS) expect(op.resource).toBe(ResourceName.DISK)
  })

  it('contains all disk op names', () => {
    const names = new Set(DISK_OPS.map((op) => op.name))
    expect(names).toEqual(
      new Set([
        'append',
        'create',
        'mkdir',
        'read',
        'readdir',
        'rename',
        'rmdir',
        'setattr',
        'stat',
        'truncate',
        'unlink',
        'write',
      ]),
    )
  })

  it('registers format-specific read variants via filetype', () => {
    const formats = DISK_OPS.filter((op) => op.name === 'read' && op.filetype !== null).map(
      (op) => op.filetype,
    )
    expect(formats.sort()).toEqual(['.feather', '.hdf5', '.parquet'])
  })

  it('write-side ops are flagged write:true', () => {
    const writes = new Set(DISK_OPS.filter((o) => o.write).map((o) => o.name))
    expect(writes).toEqual(
      new Set([
        'append',
        'create',
        'mkdir',
        'rename',
        'rmdir',
        'setattr',
        'truncate',
        'unlink',
        'write',
      ]),
    )
  })

  it('exports each op individually', () => {
    expect(appendOp.name).toBe('append')
    expect(createOp.name).toBe('create')
    expect(mkdirOp.name).toBe('mkdir')
    expect(readOp.name).toBe('read')
    expect(readFeatherOp.filetype).toBe('.feather')
    expect(readHdf5Op.filetype).toBe('.hdf5')
    expect(readParquetOp.filetype).toBe('.parquet')
    expect(readdirOp.name).toBe('readdir')
    expect(renameOp.name).toBe('rename')
    expect(rmdirOp.name).toBe('rmdir')
    expect(statOp.name).toBe('stat')
    expect(truncateOp.name).toBe('truncate')
    expect(unlinkOp.name).toBe('unlink')
    expect(writeOp.name).toBe('write')
  })
})
