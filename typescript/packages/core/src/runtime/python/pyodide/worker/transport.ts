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

import { classify } from '../../../../errors/index.ts'
import { failureText } from './failure.ts'
import type { VfsRequest } from './types.ts'

const CAPACITY = 64 * 1024
const HEADER_BYTES = 16
const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** The query parameter that marks a request for the service worker bridge. */
export const PARAM = 'mirage-pyodide'
/** The header that carries an answer's format across the bridge. */
export const FORMAT = 'x-mirage-pyodide-format'

/** An answer as bytes and their format: 0 JSON, 1 raw bytes, 2 a JSON error. */
async function encode(
  operation: () => Promise<unknown>,
): Promise<{ format: number; bytes: Uint8Array }> {
  try {
    const value = await operation()
    if (value instanceof Uint8Array) return { format: 1, bytes: value }
    return { format: 0, bytes: ENC.encode(JSON.stringify(value ?? null)) }
  } catch (error) {
    return {
      format: 2,
      bytes: ENC.encode(JSON.stringify({ message: failureText(error), code: classify(error) })),
    }
  }
}

function decode(format: number, bytes: Uint8Array): unknown {
  if (format === 1) return bytes
  const value: unknown = JSON.parse(DEC.decode(bytes))
  if (format === 2) {
    const error = value as { message: string; code: string | null }
    throw Object.assign(new Error(error.message), { code: error.code })
  }
  return value === null ? undefined : value
}

/** Worker-only blocking half; the host always answers asynchronously. */
export function requestSync(
  post: (message: VfsRequest) => void,
  request: Omit<VfsRequest, 'kind' | 'buffer' | 'id'>,
  interrupt?: Int32Array,
): unknown {
  const buffer = new SharedArrayBuffer(HEADER_BYTES + CAPACITY)
  const cells = new Int32Array(buffer, 0, 4)
  const chunk = new Uint8Array(buffer, HEADER_BYTES)
  post({ ...request, kind: 'vfs', buffer })
  let output: Uint8Array | undefined
  let offset = 0
  for (;;) {
    while (Atomics.load(cells, 0) === 0) {
      if (
        interrupt !== undefined &&
        (Atomics.load(interrupt, 0) === 2 || Atomics.load(interrupt, 1) !== 0)
      ) {
        Atomics.store(cells, 0, -1)
        Atomics.notify(cells, 0)
        throw new Error('pyodide filesystem request interrupted')
      }
      Atomics.wait(cells, 0, 0, 100)
    }
    if (Atomics.load(cells, 0) === -1) throw new Error('pyodide worker closed')
    output ??= new Uint8Array(Atomics.load(cells, 1))
    const length = Atomics.load(cells, 2)
    const format = Atomics.load(cells, 3)
    output.set(chunk.subarray(0, length), offset)
    offset += length
    Atomics.store(cells, 0, 0)
    Atomics.notify(cells, 0)
    if (offset < output.length) continue
    return decode(format, output)
  }
}

/** Stream arbitrary-size responses through a bounded shared buffer. */
export async function respond(
  buffer: SharedArrayBuffer,
  operation: () => Promise<unknown>,
): Promise<void> {
  const cells = new Int32Array(buffer, 0, 4)
  const chunk = new Uint8Array(buffer, HEADER_BYTES)
  const { format, bytes } = await encode(operation)
  let offset = 0
  do {
    if (Atomics.load(cells, 0) === -1) return
    const length = Math.min(CAPACITY, bytes.length - offset)
    chunk.set(bytes.subarray(offset, offset + length))
    Atomics.store(cells, 1, bytes.length)
    Atomics.store(cells, 2, length)
    Atomics.store(cells, 3, format)
    Atomics.store(cells, 0, 1)
    Atomics.notify(cells, 0)
    offset += length
    while (Atomics.load(cells, 0) === 1) {
      // The host must never Atomics.wait: it owns the backend event loop.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  } while (offset < bytes.length)
}

/**
 * Worker-only blocking half where no memory is shared: the request goes
 * to the host as a message, and the worker waits on a synchronous request
 * that the page's service worker holds until the host's answer arrives.
 *
 * Args:
 *   post: sends the request to the host.
 *   request: the call to make.
 *   bridge: the page URL the service worker answers bridge requests at.
 */
export function requestOverBridge(
  post: (message: VfsRequest) => void,
  request: Omit<VfsRequest, 'kind' | 'buffer' | 'id'>,
  bridge: string,
): unknown {
  const id = crypto.randomUUID()
  post({ ...request, kind: 'vfs', id })
  const xhr = new XMLHttpRequest()
  xhr.open('GET', `${bridge}?${PARAM}=wait&id=${id}`, false)
  xhr.responseType = 'arraybuffer'
  xhr.send()
  const format = xhr.getResponseHeader(FORMAT)
  if (format === null) throw new Error(`pyodide filesystem bridge answered ${String(xhr.status)}`)
  return decode(Number(format), new Uint8Array(xhr.response as ArrayBuffer))
}

/**
 * Answer one bridged request: the service worker hands the answer to the
 * worker's request waiting under `id`.
 *
 * Args:
 *   bridge: the page URL the service worker answers bridge requests at.
 *   id: the request being answered.
 *   operation: computes the answer.
 */
export async function answerOverBridge(
  bridge: string,
  id: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const { format, bytes } = await encode(operation)
  const response = await fetch(`${bridge}?${PARAM}=answer&id=${id}`, {
    method: 'POST',
    body: bytes as Uint8Array<ArrayBuffer>,
    headers: { [FORMAT]: String(format) },
  })
  if (!response.headers.has(FORMAT))
    throw new Error(`pyodide filesystem bridge answered ${String(response.status)}`)
}

/**
 * Whether the service worker controlling the page answers bridge requests.
 *
 * Args:
 *   bridge: the page URL the service worker answers bridge requests at.
 */
export async function bridged(bridge: string): Promise<boolean> {
  const response = await fetch(`${bridge}?${PARAM}=ping`)
  return response.headers.has(FORMAT)
}
