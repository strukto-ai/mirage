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

import { Channel, type ConsoleChunk, JobConsole, MountMode, RAMResource } from '@struktoai/mirage-core'
import { RedisConsoleStore, Workspace } from '@struktoai/mirage-node'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'
const POLL_MS = 100
const TIMEOUT_MS = 60_000
const ENC = new TextEncoder()
const DEC = new TextDecoder()

let fail = 0
const created: RedisConsoleStore[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  OK   ${name}`)
  } else {
    console.log(`  FAIL ${name} ${detail}`)
    fail = 1
  }
}

function jobStore(prefix: string, jobId: number): RedisConsoleStore {
  return new RedisConsoleStore({ url: REDIS_URL, keyPrefix: `${prefix}job:${jobId.toString()}:` })
}

// The reader-to-writer handshake rides a console stream too, so the
// battery needs no redis client of its own.
function signalStore(prefix: string): RedisConsoleStore {
  return new RedisConsoleStore({ url: REDIS_URL, keyPrefix: `${prefix}signal:` })
}

// The factory owns its stores' lifecycle: the workspace never closes a
// console it was handed, so the embedder tracks and closes them (an
// open client would hold the process alive).
function consoleFor(prefix: string, jobId: number): JobConsole {
  const store = jobStore(prefix, jobId)
  created.push(store)
  return new JobConsole(store)
}

async function closeCreated(): Promise<void> {
  for (const store of created) {
    await store.close()
  }
}

function makeWorkspace(prefix: string): Workspace {
  return new Workspace(
    { '/data': new RAMResource() },
    {
      mode: MountMode.EXEC,
      consoleFactory: (jobId) => consoleFor(prefix, jobId),
    },
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function joined(chunks: ConsoleChunk[], channel: Channel): string {
  return chunks
    .filter((c) => c.channel === channel)
    .map((c) => DEC.decode(c.data))
    .join('')
}

// Poll until the job's stream holds its first chunk.
async function attach(store: RedisConsoleStore): Promise<ConsoleChunk[]> {
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    const [chunks] = await store.readFrom(0)
    if (chunks.length > 0) return chunks
    if (Date.now() > deadline) throw new Error('reader: job stream never appeared')
    await sleep(POLL_MS)
  }
}

async function waitSignal(prefix: string): Promise<void> {
  const sig = signalStore(prefix)
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    const [chunks] = await sig.readFrom(0)
    if (chunks.length > 0) break
    if (Date.now() > deadline) throw new Error('writer: reader never signalled')
    await sleep(POLL_MS)
  }
  await sig.close()
}

async function sendSignal(prefix: string): Promise<void> {
  const sig = signalStore(prefix)
  await sig.append(Channel.STDOUT, ENC.encode('go'))
  await sig.close()
}

// Same-process round trip: shell jobs on a redis console, output
// adopted by `wait` and persisted in redis past the reap.
async function solo(prefix: string): Promise<void> {
  const ws = makeWorkspace(prefix)
  const result = await ws.execute('(echo out; echo err 1>&2) & wait')
  check('ts solo: exit 0', result.exitCode === 0)
  check('ts solo: stdout adopted', result.stdoutText.includes('out\n'), result.stdoutText)
  check('ts solo: stderr adopted', result.stderrText.includes('err\n'), result.stderrText)
  const reader = jobStore(prefix, 1)
  const jobConsole = new JobConsole(reader)
  const snapOut = DEC.decode(await jobConsole.snapshot(Channel.STDOUT))
  const snapErr = DEC.decode(await jobConsole.snapshot(Channel.STDERR))
  check(
    'ts solo: chunks persisted in redis',
    snapOut === 'out\n' && snapErr === 'err\n',
    `got ${JSON.stringify(snapOut)} / ${JSON.stringify(snapErr)}`,
  )
  await reader.close()
  await ws.close()
  await closeCreated()
}

// Run a job that parks until the foreign reader has attached, so the
// reader provably follows it mid-run.
async function write(prefix: string): Promise<void> {
  const ws = makeWorkspace(prefix)
  const submitted = await ws.execute(
    '(echo started; until [ -s /data/go ]; do sleep 0.1; done; echo finished) &',
  )
  check('ts write: job submitted', submitted.exitCode === 0)
  await waitSignal(prefix)
  const released = await ws.execute('echo go > /data/go')
  check('ts write: released the job', released.exitCode === 0)
  const waited = await ws.execute('wait')
  check('ts write: wait joined', waited.exitCode === 0)
  await ws.close()
  await closeCreated()
}

// Attach to the foreign writer's job console and follow it live.
async function read(prefix: string): Promise<void> {
  const store = jobStore(prefix, 1)
  const chunks = await attach(store)
  const control = chunks.filter((c) => c.channel === Channel.CONTROL)
  check('ts read: attached mid-run, no ending chunk yet', control.length === 0)
  check(
    'ts read: first line before the job was released',
    joined(chunks, Channel.STDOUT) === 'started\n',
    joined(chunks, Channel.STDOUT),
  )
  await sendSignal(prefix)
  const got: ConsoleChunk[] = []
  for await (const chunk of new JobConsole(store).follow()) {
    got.push(chunk)
  }
  const stdout = joined(got, Channel.STDOUT)
  const outcome = joined(got, Channel.CONTROL)
  check('ts read: streamed both lines', stdout === 'started\nfinished\n', stdout)
  check('ts read: job ended with exit:0', outcome === 'exit:0', outcome)
  await store.close()
}

// Kill a running job once the foreign reader is watching it.
async function killWrite(prefix: string): Promise<void> {
  const ws = makeWorkspace(prefix)
  const submitted = await ws.execute('(echo started; sleep 500) &')
  check('ts kill-write: job submitted', submitted.exitCode === 0)
  await waitSignal(prefix)
  const killed = await ws.execute('kill %1')
  check('ts kill-write: kill %1', killed.exitCode === 0)
  await ws.close()
  await closeCreated()
}

// A follower of a killed job sees the marker and the outcome.
async function killRead(prefix: string): Promise<void> {
  const store = jobStore(prefix, 1)
  const chunks = await attach(store)
  const control = chunks.filter((c) => c.channel === Channel.CONTROL)
  check('ts kill-read: attached mid-run, no ending chunk yet', control.length === 0)
  await sendSignal(prefix)
  const got: ConsoleChunk[] = []
  for await (const chunk of new JobConsole(store).follow()) {
    got.push(chunk)
  }
  const stderr = joined(got, Channel.STDERR)
  const outcome = joined(got, Channel.CONTROL)
  check('ts kill-read: Killed marker on stderr', stderr === 'Killed', stderr)
  check('ts kill-read: killed outcome', outcome === 'killed', outcome)
  await store.close()
}

async function main(): Promise<void> {
  const role = process.argv[2] ?? ''
  const prefix = process.argv[3] ?? ''
  if (role === 'solo') {
    await solo(prefix)
  } else if (role === 'write') {
    await write(prefix)
  } else if (role === 'read') {
    await read(prefix)
  } else if (role === 'kill-write') {
    await killWrite(prefix)
  } else if (role === 'kill-read') {
    await killRead(prefix)
  } else {
    throw new Error(`unknown role: ${role}`)
  }
  if (fail !== 0) process.exitCode = 1
}

await main()
