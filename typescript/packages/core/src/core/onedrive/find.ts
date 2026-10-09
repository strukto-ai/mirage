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

import type { OneDriveAccessor } from '../../accessor/onedrive.ts'
import { startBasename } from '../generic/find_eval.ts'
import { FileType, type PathSpec } from '../../types.ts'
import { isEnoent } from '../../errors/fs.ts'
import type { FindOptions } from '../../vfs/types.ts'
import { findItems } from '../msgraph/drive.ts'
import { driveLoc } from './client.ts'
import { stat } from './stat.ts'

async function dirExists(accessor: OneDriveAccessor, path: PathSpec): Promise<boolean> {
  try {
    return (await stat(accessor, path)).type === FileType.DIRECTORY
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
}

export async function find(
  accessor: OneDriveAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  return findItems(
    accessor.config,
    driveLoc(accessor.config, path.vfsPath),
    startBasename(path.virtual),
    () => dirExists(accessor, path),
    options,
  )
}
