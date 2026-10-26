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
import { adoptModule } from '../../../../rs/stream.ts'
import { PathSpec } from '../../../../types.ts'
import { PrefixResolver } from '../../../resolver.ts'
import type { BridgeDispatchFn } from '../../../types.ts'
import type { VFSEntry, VFSStat } from '../../../types.ts'
import { PyodideRuntime } from '../runtime.ts'
import type { FlushFailure, SyncVFS } from '../fs/types.ts'
import { failureText, requestOverBridge, requestSync } from '../../../wasm/transport.ts'
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
let bridge: string | undefined
const call = (request: Omit<VfsRequest, 'kind' | 'buffer' | 'id'>): unknown =>
  bridge === undefined
    ? requestSync(post, request, interrupt)
    : requestOverBridge(post, request, bridge)
console.warn = (...messages: unknown[]) => {
  post({ kind: 'notice', message: messages.map(String).join(' ') })
}
const sync: SyncVFS = {
  checkPath: (path, follow) => {
    call({
      op: 'dispatch',
      path,
      args: ['stat', path, undefined, undefined, { admitOnly: true, nofollow: !follow }],
    })
  },
  process: (payload) => call({ op: 'process', path: '', payload }) as string,
  stdin: (size) => call({ op: 'stdin', path: '', size }) as Uint8Array,
  output: (fd, bytes) => call({ op: 'output', path: '', fh: fd, bytes }) as boolean,
  open: (path, mode) => call({ op: 'open', path, mode }) as number,
  pread: (fh, offset, size) => call({ op: 'pread', path: '', fh, offset, size }) as Uint8Array,
  pwrite: (fh, offset, bytes) => {
    call({ op: 'pwrite', path: '', fh, offset, bytes })
  },
  fstat: (fh) => call({ op: 'fstat', path: '', fh }) as VFSStat,
  ftruncate: (fh, size) => {
    call({ op: 'ftruncate', path: '', fh, size })
  },
  close: (fh) => {
    call({ op: 'close', path: '', fh })
  },
  stat: (path) => call({ op: 'stat', path }) as VFSStat,
  readdir: (path, classify = true) => call({ op: 'readdir', path, classify }) as VFSEntry[],
  readlink: (path) => call({ op: 'readlink', path }) as string,
  flush: (mutations) => {
    if (mutations.length > 0)
      return call({ op: 'flush', path: '', mutations }) as FlushFailure | undefined
  },
  xattr: (op, path, name, value, attrs) =>
    call({ op: 'dispatch', path, args: [op, path, value, name, attrs] }),
}
const dispatch: BridgeDispatchFn = (...args) =>
  Promise.resolve(call({ op: 'dispatch', path: args[1], args }))
let runtime: PyodideRuntime | null = null
let prefixes: string[] = []
async function execute(request: ExecuteRequest): Promise<void> {
  try {
    prefixes = request.prefixes
    if (runtime === null) {
      if (request.wasm !== undefined) adoptModule(request.wasm)
      interrupt =
        request.interruptBuffer === undefined ? undefined : new Int32Array(request.interruptBuffer)
      bridge = request.bridge
      runtime = new PyodideRuntime({ config: request.config }, sync, request.interruptBuffer)
      // No files cross to the worker: its file adapter rides the bridge the
      // main thread answers.
      runtime.bind(WorkspaceBinding.overBridge(dispatch, new PrefixResolver(() => prefixes)))
    }
    // The program the main thread resolved, its script rebuilt from the
    // fields structured clone kept.
    const { scriptPath, ...program } = request.program
    const value = await runtime.interpret(
      undefined,
      { ...program, ...(scriptPath !== undefined ? { scriptPath: new PathSpec(scriptPath) } : {}) },
      {
        stdin: null,
        flags: request.flags,
        cwd: PathSpec.fromStrPath(request.cwd),
        env: request.env,
        ...(request.timeoutSeconds !== undefined ? { timeoutSeconds: request.timeoutSeconds } : {}),
      },
    )
    post({ kind: 'result', value })
  } catch (error) {
    post({
      kind: 'error',
      message: failureText(error),
      name: error instanceof Error ? error.name : 'Error',
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
