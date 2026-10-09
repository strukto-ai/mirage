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
import type { VFSStat } from '../../types.ts'
import { WASI, errnoFor } from './errors.ts'

export async function stat(
  ctx: QuickJSAsyncContext,
  files: RuntimeFiles | null,
  path: string,
): Promise<QuickJSHandle> {
  let st: VFSStat | null = null
  let errno = 0
  if (files === null) {
    errno = WASI.ENOENT
  } else {
    try {
      st = await files.viewStat(path)
      if (st === null) errno = WASI.ENOENT
    } catch (err) {
      errno = errnoFor(err)
    }
  }
  const tuple = ctx.newArray()
  if (st === null) {
    ctx.setProp(tuple, 0, ctx.null)
  } else {
    const obj = ctx.newObject()
    const setNum = (key: string, value: number): void => {
      const h = ctx.newNumber(value)
      ctx.setProp(obj, key, h)
      h.dispose()
    }
    setNum('dev', 0)
    setNum('ino', 0)
    setNum('mode', st.mode)
    setNum('nlink', st.isDir ? 2 : 1)
    setNum('uid', 0)
    setNum('gid', 0)
    setNum('rdev', st.rdev ?? 0)
    setNum('size', st.size)
    setNum('blocks', Math.ceil(st.size / 512))
    setNum('atime', st.mtimeMs ?? 0)
    setNum('mtime', st.mtimeMs ?? 0)
    setNum('ctime', st.mtimeMs ?? 0)
    ctx.setProp(tuple, 0, obj)
    obj.dispose()
  }
  const errH = ctx.newNumber(errno)
  ctx.setProp(tuple, 1, errH)
  errH.dispose()
  return tuple
}
