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

import WebSocket from 'ws'

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
  const closed = new Promise<void>((resolve) => {
    ws.once('close', () => {
      resolve()
    })
  })
  ws.on('message', (data: Buffer) => {
    process.stdout.write(data)
  })
  const forward = (chunk: Buffer): void => {
    ws.send(chunk)
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
