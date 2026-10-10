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

import type { QuickJSAsyncContext, QuickJSHandle } from 'quickjs-emscripten'
import type { RuntimeFiles } from '../../files.ts'
import { WASI, errnoFor } from '../../../errors/wasi.ts'
import { compareCodePoints } from '../../../utils/sort.ts'

export async function readdir(
  ctx: QuickJSAsyncContext,
  files: RuntimeFiles | null,
  path: string,
): Promise<QuickJSHandle> {
  const names: string[] = []
  let errno = 0
  if (files === null) {
    errno = WASI.ENOENT
  } else {
    try {
      const prefix = path.endsWith('/') ? path : path + '/'
      for (const entry of await files.readdir(prefix, false)) {
        const rel = entry.path.replace(/\/$/, '').slice(prefix.length)
        if (rel.length > 0 && !rel.includes('/')) names.push(rel)
      }
      names.sort(compareCodePoints)
    } catch (err) {
      errno = errnoFor(err)
    }
  }
  const namesArr = ctx.newArray()
  names.forEach((name, i) => {
    const s = ctx.newString(name)
    ctx.setProp(namesArr, i, s)
    s.dispose()
  })
  const tuple = ctx.newArray()
  ctx.setProp(tuple, 0, namesArr)
  namesArr.dispose()
  const errH = ctx.newNumber(errno)
  ctx.setProp(tuple, 1, errH)
  errH.dispose()
  return tuple
}
