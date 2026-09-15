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

import { WorkspaceBinding } from '../../../binding.ts'
import { expect, it, vi } from 'vitest'
import { PyodideRuntime } from '../runtime.ts'
import { PrefixResolver } from '../../../resolver.ts'
import type { BridgeDispatchFn } from '../../../types.ts'
import { FileStat, FileType } from '../../../../types.ts'

const state = vi.hoisted(() => ({ mode: 'construction', terminated: 0 }))
vi.mock('node:worker_threads', () => ({
  Worker: class {
    constructor(_source: unknown, options?: { eval?: boolean }) {
      if (options?.eval || state.mode === 'construction') throw new Error('workers blocked')
    }
    on(event: string, receive: (value: unknown) => void): void {
      if (event === 'error')
        queueMicrotask(() => {
          receive(new Error('worker module blocked'))
        })
    }
    terminate(): Promise<number> {
      state.terminated += 1
      return Promise.resolve(0)
    }
  },
}))

it.each(['construction', 'startup'])(
  'uses the eager VFS after worker %s fails',
  async (mode) => {
    state.mode = mode
    state.terminated = 0
    const calls: string[] = []
    const dispatch: BridgeDispatchFn = (op, path) => {
      calls.push(op)
      if (op === 'readdir') return Promise.resolve(['/data/one.txt'])
      if (op === 'stat')
        return Promise.resolve(new FileStat({ name: path, type: FileType.FILE, size: 5 }))
      if (op === 'read') return Promise.resolve(new TextEncoder().encode('hello'))
      return Promise.reject(new Error(`unexpected ${op}`))
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/data/'])))
    try {
      for (let i = 0; i < 2; i++) {
        const result = await rt.run({
          code: "print(open('/data/one.txt').read())",
          args: [],
          env: {},
          stdin: null,
        })
        expect(result.exitCode).toBe(0)
        expect(new TextDecoder().decode(result.stdout)).toBe('hello\n')
      }
      expect(calls).toContain('readdir')
      expect(state.terminated).toBe(mode === 'startup' ? 1 : 0)
    } finally {
      await rt.close()
    }
  },
  60_000,
)
