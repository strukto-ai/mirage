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

import type { GDocsAccessor } from '../../accessor/gdocs.ts'
import { read as coreRead } from '../../core/gdocs/read.ts'
import type { OpKwargs, RegisteredOp } from '../registry.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { type PathSpec, VFSName } from '../../types.ts'

export const readOp: RegisteredOp = {
  name: 'read',
  vfs: VFSName.GDOCS,
  filetype: '.gdoc.json',
  write: false,
  // A backend that registers its own read op does not go through
  // makeGenericOps, so the read-and-slice fallback never reaches it: the
  // window has to be applied here or the whole file comes back. These bytes
  // are rendered, so there is nothing to push down.
  fn: async (
    accessor: GDocsAccessor,
    path: PathSpec,
    _args: readonly unknown[],
    kwargs: OpKwargs,
  ) => {
    const offset = typeof kwargs.offset === 'number' ? kwargs.offset : 0
    const size = typeof kwargs.size === 'number' ? kwargs.size : null
    if (size === 0) return new Uint8Array(0)
    const data = await coreRead(accessor, path, kwargs.index)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  },
}
