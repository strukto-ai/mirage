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

import { expect, it } from 'vitest'
import { IOResult } from '../../../../../io/types.ts'
import type { DispatchFn } from '../../../../../runtime/types.ts'
import { FileStat, FileType, PathSpec } from '../../../../../types.ts'
import { enoent, eacces } from '../../../../../errors/fs.ts'
import { guardDispatch } from '../../../../../workspace/abort.ts'
import { runMv } from './mv.ts'

it.each(['read', 'write'])(
  'cancelled move stops dispatch after pending %s settles',
  async (blockedOp) => {
    const controller = new AbortController()
    const calls: [string, string][] = []
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatch: DispatchFn = async (op, path) => {
      calls.push([op, path.virtual])
      if (op === blockedOp) {
        enter()
        await pending
      }
      if (op === 'stat') {
        if (['/a/one', '/a/two'].includes(path.virtual)) {
          return [new FileStat({ name: 'source', type: FileType.FILE }), new IOResult()]
        }
        if (path.virtual === '/b') {
          return [new FileStat({ name: 'b', type: FileType.DIRECTORY }), new IOResult()]
        }
        throw enoent(path)
      }
      return [op === 'read' ? new TextEncoder().encode('payload') : null, new IOResult()]
    }
    const scopes = ['/a/one', '/a/two', '/b'].map((p) => PathSpec.fromStrPath(p))
    const running = runMv(scopes, {}, guardDispatch(dispatch, controller.signal))
    const interrupted = expect(running).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await entered
      controller.abort()
    } finally {
      release()
    }
    await interrupted
    expect(calls.some(([op]) => ['unlink', 'rmdir'].includes(op))).toBe(false)
    expect(calls).not.toContainEqual(['read', '/a/two'])
    expect(calls).not.toContainEqual(['write', '/b/two'])
  },
)

it('failed destination write preserves move source', async () => {
  const calls: [string, string][] = []
  const dispatch: DispatchFn = async (op, path) => {
    await Promise.resolve()
    calls.push([op, path.virtual])
    if (op === 'stat') {
      if (path.virtual === '/a/one') {
        return [new FileStat({ name: 'one', type: FileType.FILE }), new IOResult()]
      }
      if (path.virtual === '/b') {
        return [new FileStat({ name: 'b', type: FileType.DIRECTORY }), new IOResult()]
      }
      throw enoent(path)
    }
    if (op === 'write') throw eacces(path)
    return [op === 'read' ? new TextEncoder().encode('payload') : null, new IOResult()]
  }
  const scopes = ['/a/one', '/b/one'].map((p) => PathSpec.fromStrPath(p))
  const [, io] = await runMv(scopes, {}, dispatch)
  expect(io.exitCode).toBe(1)
  expect(calls).toContainEqual(['write', '/b/one'])
  expect(calls.some(([op]) => ['unlink', 'rmdir'].includes(op))).toBe(false)
})
