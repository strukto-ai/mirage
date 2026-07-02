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

import { PathSpec, mountKey, mountPrefixOf } from '@struktoai/mirage-core'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { SCOPE_ERROR } from '../disk/constants.ts'
import { readdir } from './readdir.ts'
import { fnmatch } from '@struktoai/mirage-core'
import { gnuBasename } from '@struktoai/mirage-core'

export async function resolveGlob(
  accessor: SSHAccessor,
  paths: readonly PathSpec[],
): Promise<PathSpec[]> {
  const result: PathSpec[] = []
  for (const p of paths) {
    if (p.resolved) {
      result.push(p)
    } else if (p.pattern !== null && p.pattern !== '') {
      const dirSpec = new PathSpec({
        virtual: p.directory,
        directory: p.directory,
        resolved: true,
        resourcePath: mountKey(p.directory, mountPrefixOf(p.virtual, p.resourcePath)),
      })
      const entries = await readdir(accessor, dirSpec)
      const matched: PathSpec[] = []
      for (const e of entries) {
        if (fnmatch(gnuBasename(e), p.pattern)) {
          matched.push(
            new PathSpec({
              virtual: e,
              directory: p.directory,
              resolved: true,
              resourcePath: mountKey(e, mountPrefixOf(p.virtual, p.resourcePath)),
            }),
          )
        }
      }
      if (matched.length > SCOPE_ERROR) matched.length = SCOPE_ERROR
      result.push(...matched)
    } else {
      result.push(p)
    }
  }
  return result
}
