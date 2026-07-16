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

import { MountMode, RAMResource } from '@struktoai/mirage-core'
import { RedisWorkspaceStateStore, Workspace } from '@struktoai/mirage-node'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'
const WORKSPACE_ID = 'xstore'
const MARKER = 'xstore-history-marker'

let fail = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  OK   ${name}`)
  } else {
    console.log(`  FAIL ${name} ${detail}`)
    fail = 1
  }
}

function makeWorkspace(prefix: string): { ws: Workspace; store: RedisWorkspaceStateStore } {
  const store = new RedisWorkspaceStateStore({ url: REDIS_URL, keyPrefix: prefix })
  const ws = new Workspace(
    { '/data': new RAMResource() },
    { mode: MountMode.EXEC, workspaceId: WORKSPACE_ID, store },
  )
  return { ws, store }
}

// Populate all four planes: observer (history), namespace (symlink),
// sessions (narrowed grant), and the workspace metadata record.
async function write(prefix: string): Promise<void> {
  const { ws, store } = makeWorkspace(prefix)
  const marker = await ws.execute(`echo ${MARKER}`)
  check('ts write: marker command', marker.exitCode === 0)
  const seed = await ws.execute('tee /data/f.txt', {
    stdin: new TextEncoder().encode('shared-bytes\n'),
  })
  check('ts write: seed file', seed.exitCode === 0)
  const link = await ws.execute('ln -s /data/f.txt /data/l.txt')
  check('ts write: symlink', link.exitCode === 0)
  ws.createSession('narrow', { mounts: { '/data': 'read' } })
  await ws.flushSessions()
  await ws.close()
  await store.close()
}

// Attach with only the store config + workspace id and verify every plane
// written by the other language.
async function read(prefix: string): Promise<void> {
  const probe = new RedisWorkspaceStateStore({ url: REDIS_URL, keyPrefix: prefix })
  const meta = await probe.loadMeta(WORKSPACE_ID)
  check('ts read: meta record found', meta !== null)
  check(
    'ts read: default session id',
    meta?.default_session_id === 'default',
    `got ${JSON.stringify(meta)}`,
  )
  await probe.close()

  const { ws, store } = makeWorkspace(prefix)
  const history = await ws.execute('history')
  check('ts read: history has marker', history.stdoutText.includes(MARKER), history.stdoutText)
  const target = await ws.execute('readlink /data/l.txt')
  check('ts read: symlink target', target.stdoutText.trim() === '/data/f.txt', target.stdoutText)
  await ws.ensureSessionsLoaded()
  const session = ws.getSession('narrow')
  check(
    'ts read: session grant narrowed',
    session.mountModes !== null && session.mountModes.get('/data') === MountMode.READ,
  )
  const denied = await ws.execute('echo blocked > /data/x.txt', { sessionId: 'narrow' })
  check('ts read: narrowed write denied', denied.exitCode !== 0)
  await ws.close()
  await store.close()
}

async function main(): Promise<void> {
  const role = process.argv[2]
  const prefix = process.argv[3]
  if (role === 'write') await write(prefix)
  else if (role === 'read') await read(prefix)
  else throw new Error(`unknown role: ${role}`)
  if (fail !== 0) process.exit(1)
}

await main()
