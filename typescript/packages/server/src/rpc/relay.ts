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

import { createInterface } from 'node:readline'
import { RPC_PARSE_ERROR } from './constants.ts'
import { CANCEL_REQUEST, errorResponse } from './server.ts'

/**
 * Relay this process's line-delimited JSON-RPC to a daemon's `/rpc`.
 * Each request is posted on its own, so answers come back as they finish
 * and `$/cancelRequest` reaches a request still running. The bearer token
 * is asked for on every request, so a login refreshed while the relay
 * runs is sent; an empty one sends none.
 */
export async function relayStdio(url: string, token: () => Promise<string>): Promise<void> {
  const write = (text: string): void => {
    process.stdout.write(text + '\n')
  }
  const forward = async (line: string): Promise<void> => {
    const bearer = await token()
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...(bearer !== '' ? { Authorization: `Bearer ${bearer}` } : {}),
        'content-type': 'application/json',
      },
      body: line,
    })
    if (response.status === 204) return
    if (response.status >= 400) {
      const { detail } = (await response.json()) as { detail?: unknown }
      throw new Error(`daemon error ${String(response.status)}: ${String(detail)}`)
    }
    write(await response.text())
  }
  const running = new Set<Promise<void>>()
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (line.trim() === '') continue
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      write(JSON.stringify(errorResponse(null, RPC_PARSE_ERROR, 'parse error')))
      continue
    }
    if ((message as { method?: unknown } | null)?.method === CANCEL_REQUEST) {
      await forward(line)
      continue
    }
    const call = forward(line).finally(() => running.delete(call))
    running.add(call)
  }
  await Promise.all(running)
}
