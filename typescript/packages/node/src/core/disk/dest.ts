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

import { stat as fsStat } from 'node:fs/promises'
import {
  ancestors,
  enotdir,
  mountedPath,
  type FsError,
  type PathSpec,
} from '@struktoai/mirage-core'
import { resolveSafe } from './utils.ts'

// The ENOTDIR `mkdir -p` owes, named after the component to blame. The disk
// backend has a kernel, so it needs no equivalent of the store-backed
// checkMkdirTarget: mkdir(recursive) already refuses a chain that crosses a
// plain file, and an existing target is already EEXIST. What the kernel cannot
// give is GNU's *wording*, because it reports the whole path where `mkdir -p`
// names the component it tripped on. So the chain is walked here, only once
// the op is known to have failed, and only to attribute the failure.
//
// Returns null when the walk finds nothing to blame, which leaves the caller
// free to re-raise the original errno: a failure this cannot explain (a
// permission gap, say) must still surface. Mirrors Python's
// mkdir_component_error.
export async function mkdirComponentError(
  root: string,
  spec: PathSpec,
  key: string,
): Promise<FsError | null> {
  for (const component of ancestors(key)) {
    try {
      const st = await fsStat(resolveSafe(root, component))
      if (!st.isDirectory()) return enotdir(mountedPath(spec, component))
    } catch {
      return null
    }
  }
  return null
}
