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

import type { RunArgs, EvalValue, RunResult, EvalResult, BridgeDispatchFn } from '../../../types.ts'
import type { PyodideConfig } from '../runtime.ts'
import type { MirageMutation } from '../vfs/journal.ts'

export type ReadOperation = 'read' | 'stat' | 'readdir' | 'readlink'
export interface VfsRequest {
  kind: 'vfs'
  buffer: SharedArrayBuffer
  op: ReadOperation | 'dispatch' | 'flush' | 'process'
  path: string
  args?: Parameters<BridgeDispatchFn>
  mutations?: MirageMutation[]
  payload?: string
}
export interface ExecuteRequest {
  kind: 'execute'
  method: 'run' | 'eval'
  config: PyodideConfig
  prefixes: string[]
  args?: Omit<RunArgs, 'cwd' | 'signal'> & { cwd?: string }
  code?: string
  cwd?: string
  inputs?: Record<string, EvalValue>
  session?: string
  interruptBuffer?: SharedArrayBuffer
}
export type WorkerResult =
  | { kind: 'notice'; message: string }
  | { kind: 'result'; value: RunResult | EvalResult }
  | { kind: 'error'; message: string; name: string; syntax?: boolean; seconds?: number }
export type WorkerMessage = VfsRequest | WorkerResult | { kind: 'ready' }
export interface WorkerPort {
  post(message: unknown): void
  onMessage(receive: (message: WorkerMessage) => void): void
  onError(receive: (error: Error) => void): void
  terminate(): void
}
