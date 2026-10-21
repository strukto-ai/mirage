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

import type { FlagValue } from '../../../../commands/spec/types.ts'
import type { Program, RunResult, BridgeDispatchFn } from '../../../types.ts'
import type { PyodideConfig } from '../config.ts'
import type { MirageMutation } from '../fs/journal.ts'

export type ReadOperation = 'read' | 'stat' | 'readdir' | 'readlink'
export interface VfsRequest {
  kind: 'vfs'
  /** The memory a worker that shares it waits on for the answer. */
  buffer?: SharedArrayBuffer
  /** The request the service worker holds for a worker that shares none. */
  id?: string
  op: ReadOperation | 'dispatch' | 'flush' | 'process'
  path: string
  args?: Parameters<BridgeDispatchFn>
  mutations?: MirageMutation[]
  payload?: string
  classify?: boolean
  raw?: boolean
}
/**
 * One run the main thread hands the worker: the program it resolved, and
 * what of the run's context the guest reads (its working directory,
 * environment, switches and limit). A PathSpec crosses as its fields,
 * which structured clone keeps and the worker rebuilds.
 */
export interface ExecuteRequest {
  kind: 'execute'
  config: PyodideConfig
  prefixes: string[]
  program: Program
  cwd: string
  env: Record<string, string>
  flags: Readonly<Record<string, FlagValue>>
  timeoutSeconds?: number
  interruptBuffer?: SharedArrayBuffer
  /** The page URL the service worker bridges file calls at, where no memory is shared. */
  bridge?: string
  /** The mirage-rs module the page compiled, which a browser worker's bundle leaves out. */
  wasm?: WebAssembly.Module
}
export type WorkerResult =
  | { kind: 'notice'; message: string }
  | { kind: 'result'; value: RunResult }
  | { kind: 'error'; message: string; name: string; seconds?: number }
export type WorkerMessage = VfsRequest | WorkerResult | { kind: 'ready' }
export interface WorkerPort {
  post(message: unknown): void
  onMessage(receive: (message: WorkerMessage) => void): void
  onError(receive: (error: unknown) => void): void
  terminate(): void
  /** The worker's memory in bytes, its heap included; absent where nothing can read it (a browser). */
  memory?: () => Promise<number>
  /** The page URL the service worker bridges file calls at; absent where memory is shared. */
  bridge?: string
  /** The mirage-rs module the worker runs on; absent where it loads its own (Node). */
  wasm?: WebAssembly.Module
}
