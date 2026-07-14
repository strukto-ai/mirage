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

import { walkFind } from '../../../../core/generic/find.ts'
import { findGeneric } from '../../generic/find.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const FIND_BUILDER: Builder = {
  name: 'find',
  fn: async (ops, accessor, paths, texts, opts) => {
    const idx = opts.index ?? undefined
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    const { find, isDirName } = ops
    if (find !== undefined) {
      return findGeneric(resolved, texts, opts, (root, options) => find(accessor, root, options))
    }
    // No backend find op: walk readdir/stat, classifying directories by the
    // isDirName hint when the backend provides one.
    return findGeneric(resolved, texts, opts, (root, options) =>
      walkFind(
        root,
        {
          readdir: (spec, i) => ops.readdir(accessor, spec, i),
          stat: (spec, i) => ops.stat(accessor, spec, i),
          isDirName: isDirName === undefined ? () => null : (child) => isDirName(accessor, child),
        },
        options,
        idx,
      ),
    )
  },
}
