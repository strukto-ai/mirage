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

import type { FastifyInstance } from 'fastify'
import { type WebSocket, createWebSocketStream } from 'ws'
import type { WorkspaceRegistry } from '../registry.ts'
import type { SSHEndpoint } from '../ssh/types.ts'

export interface SshRoutesDeps {
  registry: WorkspaceRegistry
  ssh: SSHEndpoint
}

interface SshParams {
  id: string
}

/**
 * Carry one SSH connection to a workspace over a WebSocket. The auth hook
 * has checked the caller's token; the account it names must be allowed the
 * workspace, else the upgrade answers 404 before any SSH. The login needs
 * no key and may only name this workspace. `ssh -o ProxyCommand="mirage
 * ssh-proxy %r"` reaches it. The SSH server is loaded on first use, as the
 * TCP endpoint loads it, so a daemon nobody reaches over SSH never loads ssh2.
 */
export function registerSshRoutes(app: FastifyInstance, deps: SshRoutesDeps): void {
  // An upgrade answered over HTTP was refused, maybe by a hook that ran
  // before the WebSocket plugin took charge of its socket (the host check,
  // auth); the socket is no longer the server's, so it is ended here.
  app.addHook('onResponse', (req, _reply, done) => {
    req.raw.socket.destroy()
    done()
  })
  app.get<{ Params: SshParams }>(
    '/v1/workspaces/:id/ssh',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (deps.registry.visible(req.params.id, req.account) === null) {
          return reply.status(404).send({ detail: 'workspace not found' })
        }
        try {
          await import('ssh2')
        } catch {
          return reply.status(501).send({
            detail: 'SSH over HTTPS needs ssh2; install it next to the server (npm install ssh2)',
          })
        }
      },
    },
    (socket: WebSocket, req) => {
      const stream = createWebSocketStream(socket)
      const peer = { address: req.ip, port: req.socket.remotePort ?? 0 }
      const local = { address: req.socket.localAddress ?? '', port: req.socket.localPort ?? 0 }
      void import('../ssh/server.ts')
        .then(({ serveTunnel }) =>
          serveTunnel(
            deps.registry,
            deps.ssh.config,
            stream,
            req.params.id,
            req.account,
            peer,
            local,
          ),
        )
        .catch((error: unknown) => {
          console.warn('ssh: tunnel failed', error)
          stream.destroy()
        })
    },
  )
}
