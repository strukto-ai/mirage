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

import type { RegisteredOp } from '@struktoai/mirage-core'
import { appendOp } from './append.ts'
import { createOp } from './create.ts'
import { mkdirOp } from './mkdir.ts'
import { readOp } from './read.ts'
import { readFeatherOp } from './read_feather.ts'
import { readHdf5Op } from './read_hdf5.ts'
import { readParquetOp } from './read_parquet.ts'
import { readdirOp } from './readdir.ts'
import { renameOp } from './rename.ts'
import { rmdirOp } from './rmdir.ts'
import { statOp } from './stat.ts'
import { truncateOp } from './truncate.ts'
import { unlinkOp } from './unlink.ts'
import { writeOp } from './write.ts'

export const REDIS_OPS: readonly RegisteredOp[] = [
  appendOp,
  createOp,
  mkdirOp,
  readOp,
  readFeatherOp,
  readHdf5Op,
  readParquetOp,
  readdirOp,
  renameOp,
  rmdirOp,
  statOp,
  truncateOp,
  unlinkOp,
  writeOp,
]
