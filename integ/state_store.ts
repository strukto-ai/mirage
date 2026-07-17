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

import { MountMode, RAMResource, type SessionStore } from '@struktoai/mirage-core'
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
  const shared = ws.createSession('shared')
  shared.env.ORIGIN = 'ts'
  await ws.flushSessions()
  check(
    'ts write: shared session at generation 1',
    shared.generation === 1,
    `got ${String(shared.generation)}`,
  )
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
    'ts read: meta carries a CAS generation',
    meta !== null && Number(meta.generation ?? 0) >= 1,
    JSON.stringify(meta),
  )
  const pointer = meta?.default_session_id
  const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  check(
    'ts read: default session id is uuid7',
    typeof pointer === 'string' && UUID7_RE.test(pointer),
    `got ${JSON.stringify(meta)}`,
  )
  await probe.close()

  const { ws, store } = makeWorkspace(prefix)
  await ws.ensureSessionsLoaded()
  check(
    "ts read: adopted writer's default session",
    ws.defaultSessionId === pointer,
    `got ${ws.defaultSessionId} want ${String(pointer)}`,
  )
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
  check(
    'ts read: generation survived the wire',
    session.generation >= 1,
    `got ${String(session.generation)}`,
  )
  const denied = await ws.execute('echo blocked > /data/x.txt', { sessionId: 'narrow' })
  check('ts read: narrowed write denied', denied.exitCode !== 0)

  // CAS against the record the other language wrote: the Lua compare
  // must parse its JSON bytes.
  const shared = ws.getSession('shared')
  const base = shared.generation
  check(
    'ts read: shared session hydrated',
    shared.env.ORIGIN === 'py' && base >= 1,
    `got env=${JSON.stringify(shared.env)} generation=${String(base)}`,
  )
  shared.env.REPLY = 'ts'
  await ws.flushSessions()
  const sessStore = store.sessions(WORKSPACE_ID)
  const bumped = (await sessStore.load()).get('shared')
  check(
    'ts read: flush CAS-bumped the foreign record',
    bumped?.generation === base + 1,
    JSON.stringify(bumped),
  )
  check(
    'ts read: stale casSet rejected',
    (await sessStore.casSet('shared', { ...(bumped ?? {}) }, base)) === false,
  )
  // A third writer advances the record behind our back; the next flush
  // must adopt its generation and land serialized on top.
  await sessStore.set('shared', { ...(bumped ?? {}), generation: base + 5 })
  shared.env.AGAIN = 'ts'
  await ws.flushSessions()
  const final = (await sessStore.load()).get('shared')
  const finalEnv = (final?.env ?? {}) as Record<string, string>
  check(
    'ts read: conflict adopted and serialized',
    final?.generation === base + 6 && finalEnv.AGAIN === 'ts',
    JSON.stringify(final),
  )
  await ws.close()
  await store.close()
}

// Read-modify-CAS this worker's counter, retrying until it lands.
async function casIncrement(sess: SessionStore, worker: string, rounds: number): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    let landed = false
    for (let attempt = 0; attempt < 500 && !landed; attempt++) {
      const record = (await sess.load()).get('hot') ?? { session_id: 'hot', env: {} }
      const env = { ...((record.env ?? {}) as Record<string, string>) }
      env[worker] = String(Number(env[worker] ?? '0') + 1)
      const expected = Number(record.generation ?? 0)
      landed = await sess.casSet('hot', { ...record, env, generation: expected + 1 }, expected)
    }
    if (!landed) throw new Error(`${worker}: cas retry budget exhausted`)
  }
}

// Race the other language's hammer process on one shared record.
// Announce with one increment, wait until the peer's counter shows up
// (so both main loops genuinely overlap), then run the rest.
async function hammer(prefix: string, rounds: number): Promise<void> {
  const store = new RedisWorkspaceStateStore({ url: REDIS_URL, keyPrefix: prefix })
  const sess = store.sessions(WORKSPACE_ID)
  await casIncrement(sess, 'ts', 1)
  let peerSeen = false
  for (let attempt = 0; attempt < 300 && !peerSeen; attempt++) {
    const env = ((await sess.load()).get('hot')?.env ?? {}) as Record<string, string>
    peerSeen = env.py !== undefined
    if (!peerSeen) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!peerSeen) throw new Error('ts hammer: peer never showed up')
  await casIncrement(sess, 'ts', rounds - 1)
  console.log(`  OK   ts hammer: ${String(rounds)} increments landed`)
  await store.close()
}

// Both hammers done: no increment may be lost.
async function casVerify(prefix: string, rounds: number): Promise<void> {
  const store = new RedisWorkspaceStateStore({ url: REDIS_URL, keyPrefix: prefix })
  const sess = store.sessions(WORKSPACE_ID)
  const final = (await sess.load()).get('hot')
  const env = (final?.env ?? {}) as Record<string, string>
  check(
    'ts verify: concurrent hammers lost no updates',
    final?.generation === 2 * rounds && env.py === String(rounds) && env.ts === String(rounds),
    JSON.stringify(final),
  )
  await store.close()
}

async function main(): Promise<void> {
  const role = process.argv[2]
  const prefix = process.argv[3]
  if (role === 'write') await write(prefix)
  else if (role === 'read') await read(prefix)
  else if (role === 'hammer') await hammer(prefix, Number(process.argv[4]))
  else if (role === 'cas-verify') await casVerify(prefix, Number(process.argv[4]))
  else throw new Error(`unknown role: ${role}`)
  if (fail !== 0) process.exit(1)
}

await main()
