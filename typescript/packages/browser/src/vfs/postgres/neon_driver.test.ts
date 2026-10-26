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

import { neonConfig } from '@neondatabase/serverless'
import { afterEach, describe, expect, it } from 'vitest'
import { NeonPgDriver } from './neon_driver.ts'

const DSN = 'postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db'
const ANSWER = JSON.stringify({
  command: 'SELECT',
  fields: [{ name: 'n', dataTypeID: 25 }],
  rowCount: 1,
  rows: [['1']],
})

// A Neon answer sent in `parts` pieces, each `gap` ms after the last; the
// request's signal fails its body, as a real fetch's does.
function trickle(parts: number, gap: number): typeof fetch {
  return (_input, init) => {
    const bytes = new TextEncoder().encode(ANSWER)
    const size = Math.ceil(bytes.length / parts)
    const signal = init?.signal
    let at = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => {
          controller.error(signal.reason)
        })
      },
      async pull(controller) {
        if (at >= bytes.length) {
          controller.close()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, gap))
        if (signal?.aborted === true) return
        controller.enqueue(bytes.subarray(at, at + size))
        at += size
      },
    })
    return Promise.resolve(new Response(body, { status: 200 }))
  }
}

afterEach(() => {
  neonConfig.fetchFunction = undefined
})

describe('NeonPgDriver', () => {
  it('lets an answer that keeps arriving run past its timeout', async () => {
    neonConfig.fetchFunction = trickle(5, 40)
    const result = await new NeonPgDriver(DSN, 0.1).query('select 1')
    expect(result.rows).toEqual([{ n: '1' }])
  })

  it('fails a query whose answer stalls past its timeout', async () => {
    neonConfig.fetchFunction = trickle(2, 300)
    await expect(new NeonPgDriver(DSN, 0.1).query('select 1')).rejects.toMatchObject({
      name: 'TimeoutError',
    })
  })

  it('takes a timeout of any positive seconds', async () => {
    neonConfig.fetchFunction = trickle(1, 0)
    const result = await new NeonPgDriver(DSN, 1.001).query('select 1')
    expect(result.rows).toEqual([{ n: '1' }])
  })
})
