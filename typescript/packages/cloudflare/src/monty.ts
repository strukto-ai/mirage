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

import {
  provideMontyModule,
  type MontyModuleLike,
} from '@struktoai/mirage-core/runtime/python/monty/loader'
import { IN_PROCESS } from '@struktoai/mirage-core/runtime/constants'
import { placeRuntime } from '@struktoai/mirage-core/runtime/table'
import * as monty from './generated/monty.js'
import core2 from './generated/monty.component.core2.wasm'
import core3 from './generated/monty.component.core3.wasm'
import core4 from './generated/monty.component.core4.wasm'
import core from './generated/monty.component.core.wasm'

const MODULES: Record<string, WebAssembly.Module> = {
  'monty.component.core.wasm': core,
  'monty.component.core2.wasm': core2,
  'monty.component.core3.wasm': core3,
  'monty.component.core4.wasm': core4,
}

/**
 * A worker that is this isolate itself: monty's own dispatch loop answers
 * each message in turn, with every message copied as a thread boundary
 * would copy it. There is no thread to end, so core holds a run to monty's
 * own clock rather than to a kill.
 */
function inProcessWorker(options: unknown): (signal?: AbortSignal) => Promise<unknown> {
  return (signal) => {
    const listeners: ((message: unknown) => void)[] = []
    let handler: ((request: unknown) => void) | undefined
    const deliver = (reply: unknown): void => {
      queueMicrotask(() => {
        for (const listener of listeners) listener(structuredClone(reply))
      })
    }
    void monty.serveDispatch(MODULES, deliver, (h) => {
      handler = h
    })
    const like = {
      post: (message: unknown): void => {
        queueMicrotask(() => handler?.(structuredClone(message)))
      },
      onMessage: (listener: (message: unknown) => void): void => {
        listeners.push(listener)
      },
      onError: (): void => undefined,
      terminate: (): void => undefined,
    }
    return monty.WorkerChannel.create(like, options, signal)
  }
}

/** Monty with one pool whose single worker runs in this isolate. */
const MONTY: MontyModuleLike = {
  ...(monty as unknown as MontyModuleLike),
  Monty: {
    async create(create: Record<string, unknown> = {}) {
      const settings = { ...create, maxProcesses: 1 }
      const pool = await monty.createWorkerPoolFromFactory(
        inProcessWorker(monty.workerChannelOptions(settings)),
        settings,
        1,
      )
      return {
        checkout: (checkout: Record<string, unknown> = {}) => pool.checkout(checkout),
        close: () => pool.close(),
      }
    },
  },
}

provideMontyModule(() => Promise.resolve(MONTY))
// Monty runs in this isolate, so here it is an `in_process` machine's runtime.
placeRuntime('monty', IN_PROCESS)
