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

import { isNode } from './loader.ts'

/**
 * Deadline interruption for pyodide, which executes on THIS thread: a
 * busy guest loop blocks the event loop, so no timer here can ever
 * fire (the quickjs runtime has an in-VM interrupt hook for this;
 * pyodide only reads a SharedArrayBuffer via setInterruptBuffer). A
 * tiny watchdog worker owns the countdown instead: it writes SIGINT
 * (2) into the shared interrupt cell at the deadline, pyodide's
 * interpreter loop sees it mid-execution and raises KeyboardInterrupt,
 * and the run reports which trip happened through the second cell.
 *
 * Cells (Int32Array over one SharedArrayBuffer): [0] the pyodide
 * interrupt cell (pyodide resets it to 0 when it fires), [1] why the
 * trip happened (1 deadline, 2 kill signal), [2] the arm generation,
 * which the watchdog re-checks at the deadline so a countdown
 * cancelled just as it fires cannot poison the next run. Cell [3]
 * records an abort from the host before the worker has armed a run.
 *
 * Environments without SharedArrayBuffer or workers (a browser page
 * that is not cross-origin isolated) get null: runs stay unbounded
 * there, exactly the pre-interrupt behavior.
 */

export interface ArmedInterrupt {
  /**
   * Stop the countdown and report the trip. Idempotent: every later call
   * repeats the first answer, so the wrapper can disarm as soon as the
   * user code returns and the host can still read why it stopped.
   */
  disarm(): 'deadline' | 'signal' | null
}

export interface PyodideInterrupter {
  /** The view to hand to pyodide.setInterruptBuffer, once. */
  readonly view: Int32Array
  arm(timeoutSeconds: number | null, signal?: AbortSignal): ArmedInterrupt
  close(): void
}

interface WatchdogPort {
  post(message: object): void
  terminate(): void
}

// The watchdog body, identical logic in both hosts: one pending
// countdown at a time, generation-checked on every tick. The reason
// cell is stored BEFORE the interrupt cell: the interrupt write can
// wake pyodide immediately, and disarm() must never observe the trip
// without its reason (it would report a timeout as a plain failure).
// Reassert until disarmed: Pyodide can consume SIGINT without unwinding
// the running WASM call, leaving a one-shot deadline permanently lost.
const WATCHDOG_BODY = `
let timer = null;
function onMessage(msg) {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (msg.cancel) return;
  const cells = new Int32Array(msg.buffer);
  const gen = msg.gen;
  const deadline = msg.delayMs == null ? Infinity : Date.now() + msg.delayMs;
  function tick() {
    if (Atomics.load(cells, 2) !== gen) return;
    const reason = Atomics.load(cells, 1) ||
      (Atomics.load(cells, 3) === 1 ? 2 : Date.now() >= deadline ? 1 : 0);
    if (reason !== 0) {
      Atomics.store(cells, 1, reason);
      Atomics.store(cells, 0, 2);
    }
    timer = setTimeout(tick, 10);
  }
  tick();
}
`

const NODE_WATCHDOG = `${WATCHDOG_BODY}
require('node:worker_threads').parentPort.on('message', onMessage);
`

const BROWSER_WATCHDOG = `${WATCHDOG_BODY}
self.onmessage = (event) => { onMessage(event.data); };
self.postMessage('ready');
`

async function createNodeWatchdog(): Promise<WatchdogPort | null> {
  try {
    const { Worker } = await import('node:worker_threads')
    const worker = new Worker(NODE_WATCHDOG, { eval: true })
    // The watchdog must never keep the process alive on its own.
    worker.unref()
    return {
      post: (message) => {
        worker.postMessage(message)
      },
      terminate: () => void worker.terminate(),
    }
  } catch {
    // No worker_threads (exotic host): degrade to unbounded runs.
    return null
  }
}

async function createBrowserWatchdog(): Promise<WatchdogPort | null> {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return null
  const url = URL.createObjectURL(new Blob([BROWSER_WATCHDOG], { type: 'text/javascript' }))
  try {
    const worker = new Worker(url)
    // A nested browser worker needs its creator's event loop to finish
    // startup. Wait for its listener before synchronous WASM can block
    // that loop; merely constructing it can leave deadlines unarmed.
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = () => {
        worker.onmessage = null
        resolve()
      }
      worker.onerror = (event) => {
        worker.terminate()
        reject(new Error(`pyodide watchdog failed: ${event.message}`))
      }
    })
    return {
      post: (message) => {
        worker.postMessage(message)
      },
      terminate: () => {
        worker.terminate()
      },
    }
  } catch {
    // Workers can exist in the host API while CSP rejects their startup.
    // Preserve the same unbounded eager fallback as a worker-less host.
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function createPyodideInterrupter(
  buffer?: SharedArrayBuffer,
): Promise<PyodideInterrupter | null> {
  if (typeof SharedArrayBuffer === 'undefined') return null
  const watchdog = isNode() ? await createNodeWatchdog() : await createBrowserWatchdog()
  if (watchdog === null) return null
  const shared = buffer ?? new SharedArrayBuffer(16)
  const cells = new Int32Array(shared)
  let generation = 0
  return {
    view: cells,
    arm(timeoutSeconds: number | null, signal?: AbortSignal): ArmedInterrupt {
      generation += 1
      Atomics.store(cells, 0, 0)
      Atomics.store(cells, 1, 0)
      Atomics.store(cells, 2, generation)
      if (Atomics.load(cells, 3) === 1) {
        Atomics.store(cells, 1, 2)
        Atomics.store(cells, 0, 2)
      }
      watchdog.post({
        buffer: shared,
        delayMs: timeoutSeconds !== null && timeoutSeconds > 0 ? timeoutSeconds * 1000 : null,
        gen: generation,
      })
      let removeAbort: (() => void) | null = null
      if (signal !== undefined) {
        const onAbort = (): void => {
          Atomics.store(cells, 1, 2)
          Atomics.store(cells, 0, 2)
        }
        if (signal.aborted) {
          onAbort()
        } else {
          signal.addEventListener('abort', onAbort, { once: true })
          removeAbort = () => {
            signal.removeEventListener('abort', onAbort)
          }
        }
      }
      let done = false
      let reason: 'deadline' | 'signal' | null = null
      return {
        disarm: (): 'deadline' | 'signal' | null => {
          if (done) return reason
          done = true
          generation += 1
          Atomics.store(cells, 2, generation)
          watchdog.post({ cancel: true })
          if (removeAbort !== null) removeAbort()
          const why = Atomics.load(cells, 1)
          Atomics.store(cells, 0, 0)
          Atomics.store(cells, 1, 0)
          reason = why === 1 ? 'deadline' : why === 2 ? 'signal' : null
          return reason
        },
      }
    },
    close(): void {
      watchdog.terminate()
    },
  }
}
