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

import { describe, expect, it } from 'vitest'
import { encode, RespClient, RespError, type SocketLike } from './resp.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

// A server that answers with `replies`, one byte per chunk, so every
// line and bulk string arrives split, then hangs up; what the client
// writes is kept.
function server(replies: string, written: Uint8Array[]): SocketLike {
  const bytes = enc.encode(replies)
  let at = 0
  return {
    readable: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at < bytes.length) controller.enqueue(bytes.subarray(at, ++at))
        else controller.close()
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(chunk)
      },
    }),
    close: () => Promise.resolve(),
  }
}

describe('RespClient', () => {
  it('reads every reply kind split across chunks, in order', async () => {
    const written: Uint8Array[] = []
    const client = new RespClient('redis://localhost:6379', () =>
      server('+PONG\r\n$3\r\nabc\r\n*3\r\n:7\r\n$-1\r\n$0\r\n\r\n-ERR no such key\r\n', written),
    )
    const [pong, value, array, error] = await client.pipeline([
      ['PING'],
      ['GET', 'k'],
      ['MGET', 'a', 'b', 'c'],
      ['BAD'],
    ])
    expect(pong).toBe('PONG')
    expect(dec.decode(value as Uint8Array)).toBe('abc')
    expect(array).toEqual([7, null, new Uint8Array(0)])
    expect(error).toBeInstanceOf(RespError)
    expect((error as RespError).message).toBe('ERR no such key')
    expect(written.map((w) => dec.decode(w)).join('')).toBe(
      dec.decode(encode([['PING'], ['GET', 'k'], ['MGET', 'a', 'b', 'c'], ['BAD']])),
    )
  })

  it('logs in and selects the database the url names before the first command', async () => {
    const written: Uint8Array[] = []
    const client = new RespClient(
      'rediss://default:s%40cret@h.example:6380/3',
      (host, port, tls) => {
        expect([host, port, tls]).toEqual(['h.example', 6380, true])
        return server('+OK\r\n+OK\r\n:1\r\n', written)
      },
    )
    expect(await client.call('EXISTS', 'k')).toBe(1)
    expect(dec.decode(written[0])).toBe(
      dec.decode(
        encode([
          ['AUTH', 'default', 's@cret'],
          ['SELECT', 3],
        ]),
      ),
    )
  })

  it('fails the waiting call when the server hangs up', async () => {
    const client = new RespClient('redis://localhost', () => server('', []))
    await expect(client.call('PING')).rejects.toThrow('the server closed the connection')
  })

  it('frames binary arguments by their byte length', () => {
    expect(dec.decode(encode([['SET', 'é', new Uint8Array([0, 13, 10])]]))).toBe(
      '*3\r\n$3\r\nSET\r\n$2\r\né\r\n$3\r\n\u0000\r\n\r\n',
    )
  })
})
