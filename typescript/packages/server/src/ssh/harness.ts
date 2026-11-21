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

import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { SessionProfile, Workspace } from '@struktoai/mirage-node'
import ssh2, { type Client, type ClientChannel } from 'ssh2'
import { WorkspaceRegistry, type WorkspaceEntry } from '../registry.ts'
import { mintKeyPair } from './keys.ts'
import { startSSHServer } from './server.ts'
import type { SSHListener } from './types.ts'

export interface Harness {
  registry: WorkspaceRegistry
  entry: WorkspaceEntry
  listener: SSHListener
  privateKey: string
  keysFile: string
}

export interface Run {
  stdout: string
  stderr: string
  code: number | null
}

const open: Harness[] = []
const clients: Client[] = []

export async function startHarness(ws?: Workspace): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-session-'))
  const pair = mintKeyPair(ssh2.utils)
  writeFileSync(join(dir, 'authorized_keys'), `${pair.public}\n`)
  const registry = new WorkspaceRegistry({ idleGraceSeconds: 0 })
  const entry = registry.add(
    ws ?? new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }),
    'demo',
  )
  const listener = await startSSHServer(registry, {
    port: 0,
    host: '127.0.0.1',
    hostKeyFile: join(dir, 'host_key'),
    authorizedKeysFile: join(dir, 'authorized_keys'),
  })
  const harness = {
    registry,
    entry,
    listener,
    privateKey: pair.private,
    keysFile: join(dir, 'authorized_keys'),
  }
  open.push(harness)
  return harness
}

export function connect(h: Harness, username = 'demo', privateKey = h.privateKey): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client()
    clients.push(client)
    client.on('ready', () => {
      resolve(client)
    })
    client.on('error', reject)
    client.connect({ host: '127.0.0.1', port: h.listener.port, username, privateKey })
  })
}

/** Authorize a fresh client key whose line carries `options`. */
export function bindKey(h: Harness, options: string): string {
  const pair = mintKeyPair(ssh2.utils)
  appendFileSync(h.keysFile, `${options} ${pair.public}\n`)
  return pair.private
}

/** A workspace whose `guarded` profile seals `/vault`. */
export async function vaultWorkspace(): Promise<Workspace> {
  const ws = new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      profiles: {
        guarded: SessionProfile({
          commands: {
            '*': { decision: 'deny', reason: 'the vault is sealed', paths: ['/vault/*'] },
          },
        }),
      },
    },
  )
  await ws.shell('mkdir -p /vault && echo token > /vault/secret')
  return ws
}

export function collect(stream: ClientChannel, stdin?: string): Promise<Run> {
  return new Promise((resolve) => {
    const run: Run = { stdout: '', stderr: '', code: null }
    stream.on('data', (d: Buffer) => {
      run.stdout += d.toString()
    })
    stream.stderr.on('data', (d: Buffer) => {
      run.stderr += d.toString()
    })
    stream.on('exit', (code: number | null) => {
      run.code = code
    })
    stream.on('close', () => {
      resolve(run)
    })
    if (stdin !== undefined) stream.end(stdin)
  })
}

export function exec(client: Client, command: string, stdin?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err !== undefined) {
        reject(err)
        return
      }
      void collect(stream, stdin).then(resolve)
    })
  })
}

export function openShell(client: Client, term: string | null): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const window = term === null ? false : { term, rows: 24, cols: 80, width: 0, height: 0 }
    client.shell(window, (err, stream) => {
      if (err !== undefined) reject(err)
      else resolve(stream)
    })
  })
}

export async function readUntil(
  stream: ClientChannel,
  needle: string,
  ms = 10_000,
): Promise<string> {
  let seen = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.off('data', onData)
      reject(new Error(`never saw ${JSON.stringify(needle)} in ${JSON.stringify(seen)}`))
    }, ms)
    const onData = (d: Buffer): void => {
      seen += d.toString()
      if (seen.includes(needle)) {
        clearTimeout(timer)
        stream.off('data', onData)
        resolve(seen)
      }
    }
    stream.on('data', onData)
  })
}

export function sshSessions(h: Harness): string[] {
  return h.entry.runner.ws
    .listSessions()
    .map((s) => s.sessionId)
    .filter((id) => id.startsWith('ssh_'))
}

/** End every client and harness a test opened. */
export async function closeHarnesses(): Promise<void> {
  for (const client of clients.splice(0)) client.end()
  for (const h of open.splice(0)) {
    await h.listener.close()
    await h.registry.closeAll()
  }
}
