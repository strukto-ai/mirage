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
import { PathSpec } from '../../../../types.ts'
import { PrefixResolver } from '../../../resolver.ts'
import type { BridgeDispatchFn } from '../../../types.ts'
import type { VFSEntry, VFSStat } from '../../../vfs.ts'
import { PyodideRuntime } from '../runtime.ts'
import type { FlushFailure, SyncVFS } from '../vfs/types.ts'
import { requestSync } from './transport.ts'
import type { ExecuteRequest, VfsRequest, WorkerMessage } from './types.ts'

const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node
const port = node === undefined ? null : (await import('node:worker_threads')).parentPort
const browser = globalThis as unknown as {
  postMessage(m: unknown): void
  onmessage: ((e: MessageEvent<ExecuteRequest>) => void) | null
}
const post = (message: WorkerMessage): void => {
  if (port !== null) port.postMessage(message)
  else browser.postMessage(message)
}
let interrupt: Int32Array | undefined
const call = (request: Omit<VfsRequest, 'kind' | 'buffer'>): unknown =>
  requestSync(post, request, interrupt)
console.warn = (...messages: unknown[]) => {
  post({ kind: 'notice', message: messages.map(String).join(' ') })
}
const sync: SyncVFS = {
  read: (path) => call({ op: 'read', path }) as Uint8Array,
  stat: (path) => call({ op: 'stat', path }) as VFSStat,
  readdir: (path) => call({ op: 'readdir', path }) as VFSEntry[],
  readlink: (path) => call({ op: 'readlink', path }) as string,
  flush: (mutations) => {
    if (mutations.length > 0)
      return call({ op: 'flush', path: '', mutations }) as FlushFailure | undefined
  },
}
const dispatch: BridgeDispatchFn = (...args) =>
  Promise.resolve(call({ op: 'dispatch', path: args[1], args }))
let runtime: PyodideRuntime | null = null
let prefixes: string[] = []
async function execute(request: ExecuteRequest): Promise<void> {
  try {
    prefixes = request.prefixes
    if (runtime === null) {
      interrupt =
        request.interruptBuffer === undefined ? undefined : new Int32Array(request.interruptBuffer)
      runtime = new PyodideRuntime({ config: request.config }, sync, request.interruptBuffer)
      runtime.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => prefixes)))
    }
    const value =
      request.method === 'run' && request.args !== undefined
        ? await runtime.run({
            ...request.args,
            ...(request.args.cwd !== undefined
              ? { cwd: PathSpec.fromStrPath(request.args.cwd) }
              : {}),
          } as Parameters<PyodideRuntime['run']>[0])
        : await runtime.eval(request.code ?? '', {
            ...(request.inputs !== undefined ? { inputs: request.inputs } : {}),
            ...(request.session !== undefined ? { session: request.session } : {}),
          })
    post({ kind: 'result', value })
  } catch (error) {
    post({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : 'Error',
      syntax: (error as { syntax?: boolean } | null)?.syntax ?? false,
      ...((error as { seconds?: number } | null)?.seconds !== undefined
        ? { seconds: (error as { seconds: number }).seconds }
        : {}),
    })
  }
}
if (port !== null)
  port.on('message', (request: ExecuteRequest) => {
    void execute(request)
  })
else
  browser.onmessage = (event) => {
    void execute(event.data)
  }
post({ kind: 'ready' })
