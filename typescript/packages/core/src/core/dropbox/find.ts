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

import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import type { FindOptions } from '../../resource/base.ts'
import type { PathSpec } from '../../types.ts'
import { walkFind } from '../generic/find.ts'
import { isDirName, readdir } from './readdir.ts'
import { stat } from './stat.ts'

// Same readdir/stat walk the generic fallback uses, wired as a find op
// so the cp builder (which plans recursive copies through find) works.
export function find(
  accessor: DropboxAccessor,
  path: PathSpec,
  options: FindOptions,
): Promise<string[]> {
  return walkFind(
    path,
    {
      readdir: (spec, index) => readdir(accessor, spec, index),
      stat: (spec, index) => stat(accessor, spec, index),
      isDirName: (child) => isDirName(child),
    },
    options,
  )
}
