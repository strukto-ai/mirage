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
