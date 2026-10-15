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

import WebSocket, { WebSocketServer } from 'ws'

/** The server would not open the tunnel. */
export class TunnelRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TunnelRefused'
  }
}

/**
 * Carry this process's stdio over a workspace's SSH route: what an ssh
 * `ProxyCommand` runs. ssh speaks on stdin and stdout, and the bytes travel
 * over the server's HTTPS port, logged in by the bearer token instead of a
 * key. `url` is the workspace's `/v1/workspaces/:id/ssh` URL as `ws://` or
 * `wss://`. Rejects with `TunnelRefused` when the server answers the
 * upgrade with an error.
 */
export async function relaySsh(url: string, headers: Record<string, string>): Promise<void> {
  const ws = new WebSocket(url, { headers, perMessageDeflate: false })
  // Listen before the upgrade settles: the server's first frame, its SSH
  // banner, can arrive in the same read as the 101, and ws emits it on a
  // tick that runs before an `await` on 'open' resumes, so a listener
  // added after that await drops the banner and ssh hangs up.
  const closed = new Promise<void>((resolve) => {
    ws.once('close', () => {
      resolve()
    })
  })
  // Each side waits for the other to take its bytes: the socket is paused
  // while stdout drains, and stdin while a chunk is being sent, so a slow
  // reader never piles a transfer up in memory.
  ws.on('message', (data: Buffer) => {
    if (!process.stdout.write(data)) {
      ws.pause()
      process.stdout.once('drain', () => {
        ws.resume()
      })
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve()
    })
    ws.once('unexpected-response', (req, res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => (body += chunk.toString()))
      res.on('end', () => {
        req.destroy()
        reject(new TunnelRefused(`the server refused: ${String(res.statusCode)} ${body.trim()}`))
      })
    })
    ws.once('error', reject)
  })
  const forward = (chunk: Buffer): void => {
    process.stdin.pause()
    ws.send(chunk, () => {
      if (ws.readyState === WebSocket.OPEN) process.stdin.resume()
    })
  }
  const finish = (): void => {
    ws.close()
  }
  process.stdin.on('data', forward)
  process.stdin.once('end', finish)
  try {
    await closed
  } finally {
    process.stdin.off('data', forward)
    process.stdin.off('end', finish)
    process.stdin.pause()
  }
}

/**
 * Serve `codex exec-server forward` on `host:port` until the process stops.
 * Each connection forward opens is carried to the workspace's codex-exec
 * route, one message for one message, logged in by the bearer token forward
 * cannot send itself, asked for anew on every connection. A connection with
 * an `Origin` header comes from a browser page, never from forward, and is
 * refused before it reaches the token. Each side waits for the other to take
 * a message before it reads the next, so a slow reader holds nothing up in
 * memory. `url` is the workspace's `/v1/workspaces/:id/codex-exec` URL as
 * `ws://` or `wss://`; port 0 picks a free one.
 */
export async function relayCodex(
  host: string,
  port: number,
  url: string,
  token: () => Promise<string>,
): Promise<void> {
  const server = new WebSocketServer({
    host,
    port,
    perMessageDeflate: false,
    verifyClient: (info, done) => {
      if (info.req.headers.origin === undefined) done(true)
      else done(false, 403, 'Origin not allowed')
    },
  })
  server.on('connection', (incoming: WebSocket) => {
    const held: [Buffer, boolean][] = []
    let upstream: WebSocket | null = null
    const fail = (message: string): void => {
      process.stderr.write(`mirage: codex-exec: ${message}\n`)
      incoming.close(1011)
    }
    incoming.on('error', (error: Error) => {
      process.stderr.write(`mirage: codex-exec: ${error.message}\n`)
      upstream?.close()
    })
    incoming.on('message', (data: Buffer, isBinary: boolean) => {
      incoming.pause()
      if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary }, () => {
          incoming.resume()
        })
      } else {
        held.push([data, isBinary])
      }
    })
    incoming.once('close', () => {
      upstream?.close()
    })
    token().then(
      (bearer) => {
        if (incoming.readyState !== WebSocket.OPEN) return
        const headers: Record<string, string> =
          bearer === '' ? {} : { Authorization: `Bearer ${bearer}` }
        const socket = new WebSocket(url, { headers, perMessageDeflate: false })
        upstream = socket
        socket.once('open', () => {
          for (const [data, isBinary] of held.splice(0)) socket.send(data, { binary: isBinary })
          incoming.resume()
        })
        socket.on('message', (data: Buffer, isBinary: boolean) => {
          socket.pause()
          incoming.send(data, { binary: isBinary }, () => {
            socket.resume()
          })
        })
        socket.once('unexpected-response', (req, res) => {
          let body = ''
          res.on('data', (chunk: Buffer) => (body += chunk.toString()))
          res.on('end', () => {
            req.destroy()
            const status = String(res.statusCode)
            process.stderr.write(
              `mirage: codex-exec: the server refused: ${status} ${body.trim()}\n`,
            )
            incoming.close(1011, `the server refused: ${status}`)
          })
        })
        socket.on('error', (error: Error) => {
          fail(error.message)
        })
        socket.once('close', () => {
          incoming.close()
        })
      },
      (error: unknown) => {
        fail(error instanceof Error ? error.message : String(error))
      },
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      resolve()
    })
    server.once('error', reject)
  })
  const bound = server.address()
  if (bound !== null && typeof bound === 'object') {
    const address = bound.family === 'IPv6' ? `[${bound.address}]` : bound.address
    process.stderr.write(`mirage: codex-exec: listening on ws://${address}:${String(bound.port)}\n`)
  }
  await new Promise<void>((resolve) => {
    server.once('close', () => {
      resolve()
    })
  })
}
