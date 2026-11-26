import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { memoryResourceStore } from '@struktoai/mirage-core/resources/memory'
import { SignJWT } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp, type BuildAppOptions, type MirageApp } from '../app.ts'
import { AuthMode } from '../auth/config.ts'
import { CONNECT_STREAM } from '../e2b/process.ts'
import { e2bListener } from './e2b_test_support.ts'

const KEY = { 'x-api-key': 'local-key' }
const CREATE = '/v2/sandboxes'
const START = '/process.Process/Start'
const MOVE = '/filesystem.Filesystem/Move'

let running: { app: MirageApp; root: string } | undefined
afterEach(async () => {
  if (running === undefined) return
  const { app, root } = running
  running = undefined
  await app.close()
  await rm(root, { recursive: true, force: true })
})

async function setup(options: BuildAppOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mirage-e2b-boundary-'))
  const app = buildApp({
    e2bPort: 8766,
    authConfig: { mode: AuthMode.Token, bearerToken: KEY['x-api-key'] },
    stateRoot: root,
    rateLimits: [],
    resourceStore: memoryResourceStore(),
    ...options,
  })
  running = { app, root }
  return { app }
}

interface SandboxResponse {
  sandboxID: string
  envdAccessToken: string
}

async function create(app: MirageApp, payload: Record<string, unknown> = {}, headers = KEY) {
  const response = await e2bListener(app).inject({ method: 'POST', url: CREATE, headers, payload })
  expect(response.statusCode, response.body).toBe(201)
  return response.json<SandboxResponse>()
}

function dataHeaders(sandbox: SandboxResponse) {
  return {
    'e2b-sandbox-id': sandbox.sandboxID,
    'e2b-sandbox-port': '49983',
    'x-access-token': sandbox.envdAccessToken,
  }
}

async function runCommand(app: MirageApp, headers: Record<string, string>, command: string) {
  const body = Buffer.from(
    JSON.stringify({ process: { cmd: '/bin/bash', args: ['-l', '-c', command] } }),
  )
  const frame = Buffer.alloc(5 + body.length)
  frame.writeUInt32BE(body.length, 1)
  body.copy(frame, 5)
  const response = await e2bListener(app).inject({
    method: 'POST',
    url: START,
    headers: { ...headers, 'content-type': 'application/connect+json' },
    payload: frame,
  })
  expect(response.statusCode, response.body).toBe(200)
}

async function setupJwt(rateLimits: NonNullable<BuildAppOptions['rateLimits']>) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const { app } = await setup({
    authConfig: {
      mode: AuthMode.Jwt,
      jwt: {
        algorithm: 'RS256',
        key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        audiences: [],
        authorizedParties: [],
        clockSkewSeconds: 0,
      },
    },
    rateLimits,
  })
  const accountKey = (subject: string) =>
    new SignJWT({})
      .setSubject(subject)
      .setExpirationTime('1m')
      .setProtectedHeader({ alg: 'RS256' })
      .sign(privateKey)
  return { app, accountKey }
}

it('charges sandbox requests to the authenticated owner', async () => {
  const { app, accountKey } = await setupJwt([{ key: 'account', rate: '3/minute' }])
  const createFor = async (subject: string) =>
    dataHeaders(await create(app, {}, { 'x-api-key': await accountKey(subject) }))
  const stat = (headers: Record<string, string>) =>
    e2bListener(app).inject({
      method: 'POST',
      url: '/filesystem.Filesystem/Stat',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { path: '/home/user' },
    })

  const alice = await createFor('alice')
  const bob = await createFor('bob')
  expect((await stat({ ...alice, 'x-access-token': 'invalid-token' })).statusCode).toBe(401)
  expect((await stat(alice)).statusCode).toBe(200)
  await runCommand(app, alice, 'true')
  const limited = await stat(alice)
  expect(limited.statusCode).toBe(429)
  expect(limited.json()).toEqual({ code: 'resource_exhausted', message: 'too many requests' })
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
  expect((await stat(bob)).statusCode).toBe(200)
})

it('shares the native workspace limit with verified sandbox routes', async () => {
  const { app, accountKey } = await setupJwt([{ key: 'workspace', rate: '3/minute' }])
  const [aliceKey, bobKey] = await Promise.all([accountKey('alice'), accountKey('bob')])
  const aliceApi = { 'x-api-key': aliceKey }
  const bobApi = { 'x-api-key': bobKey }
  const alice = dataHeaders(await create(app, {}, aliceApi))
  const bob = dataHeaders(await create(app, {}, bobApi))
  const sandboxId = alice['e2b-sandbox-id']
  const connect = (headers: Record<string, string> = {}) =>
    e2bListener(app).inject({ method: 'POST', url: `${CREATE}/${sandboxId}/connect`, headers })
  const native = () =>
    app.inject({
      url: `/v1/workspaces/${sandboxId}`,
      headers: { authorization: `Bearer ${aliceKey}` },
    })
  const stat = (headers: Record<string, string>) =>
    e2bListener(app).inject({
      method: 'POST',
      url: '/filesystem.Filesystem/Stat',
      headers,
      payload: { path: '/home/user' },
    })

  const spoofed = { ...alice, 'x-access-token': bob['x-access-token'] }
  expect((await stat(spoofed)).statusCode).toBe(401)
  expect((await connect()).statusCode).toBe(401)
  expect((await connect(bobApi)).statusCode).toBe(404)

  expect((await native()).statusCode).toBe(200)
  expect((await stat(alice)).statusCode).toBe(200)
  expect(
    (
      await e2bListener(app).inject({
        method: 'POST',
        url: `/sandboxes/${sandboxId}/timeout`,
        headers: aliceApi,
        payload: { timeout: 300 },
      })
    ).statusCode,
  ).toBe(204)

  const lifecycleLimit = await connect(aliceApi)
  expect(lifecycleLimit.statusCode).toBe(429)
  expect(lifecycleLimit.json()).toEqual({ code: 429, message: 'too many requests' })
  expect(Number(lifecycleLimit.headers['retry-after'])).toBeGreaterThan(0)
  const dataLimit = await stat(alice)
  expect(dataLimit.statusCode).toBe(429)
  expect(dataLimit.json()).toMatchObject({ code: 'resource_exhausted' })
  const nativeLimit = await native()
  expect(nativeLimit.statusCode).toBe(429)
  expect(nativeLimit.json()).toMatchObject({ error: { code: 'rate_limited' } })
  expect((await stat(spoofed)).statusCode).toBe(401)
  expect((await connect(bobApi)).statusCode).toBe(404)
  expect((await stat(bob)).statusCode).toBe(200)
})

it('moves entries through the workspace filesystem', async () => {
  const resourceStore = memoryResourceStore()
  await resourceStore.createTemplate({
    name: 'approved',
    description: null,
    config: {
      mounts: {
        '/home/user': { vfs: 'ram', mode: 'write' },
        '/other': { vfs: 'ram', mode: 'write' },
      },
    },
  })
  const { app } = await setup({ e2bTemplate: 'approved', resourceStore })
  const headers = dataHeaders(await create(app))
  await runCommand(app, headers, 'printf value > old')
  const cross = await e2bListener(app).inject({
    method: 'POST',
    url: MOVE,
    headers,
    payload: { source: 'old', destination: '/other/new' },
  })
  expect(cross.json()).toMatchObject({ code: 'failed_precondition' })
  const moved = await e2bListener(app).inject({
    method: 'POST',
    url: MOVE,
    headers,
    payload: { source: 'old', destination: 'new' },
  })
  expect(moved.statusCode, moved.body).toBe(200)
  expect(moved.json()).toMatchObject({ entry: { path: '/home/user/new' } })
  expect((await e2bListener(app).inject({ url: '/files?path=old', headers })).statusCode).toBe(404)
  expect((await e2bListener(app).inject({ url: '/files?path=new', headers })).body).toBe('value')
})

it('rejects incompatible requests before allocating workspaces', async () => {
  const { app } = await setup()
  for (const payload of [
    { autoPause: true },
    { allow_internet_access: false },
    { network: { allowPublicTraffic: false } },
    { metadata: { app: 'example' } },
  ]) {
    const response = await e2bListener(app).inject({
      method: 'POST',
      url: CREATE,
      headers: KEY,
      payload,
    })
    expect(response.statusCode, response.body).toBe(501)
    expect(response.body).toContain(Object.keys(payload)[0])
  }
  for (const media of [
    'application/connect+json',
    'application/octet-stream',
    'multipart/form-data; boundary=test',
  ]) {
    const mislabelled = await e2bListener(app).inject({
      method: 'POST',
      url: CREATE,
      headers: { ...KEY, 'content-type': media },
      payload: '{"metadata":{"app":"example"}}',
    })
    expect(mislabelled.statusCode, mislabelled.body).toBe(400)
  }
  const idempotent = await e2bListener(app).inject({
    method: 'POST',
    url: CREATE,
    headers: { ...KEY, 'idempotency-key': 'test' },
  })
  expect(idempotent.statusCode).toBe(501)
  expect(app.registry.list()).toEqual([])
  expect((await e2bListener(app).inject({ url: CREATE })).statusCode).toBe(401)
  expect((await e2bListener(app).inject({ url: CREATE, headers: KEY })).statusCode).toBe(501)
  const sandbox = await create(app, { metadata: {}, autoPause: false })
  const watcher = await e2bListener(app).inject({
    method: 'POST',
    url: '/filesystem.Filesystem/CreateWatcher',
    headers: dataHeaders(sandbox),
  })
  expect(watcher.statusCode, watcher.body).toBe(501)
  expect(watcher.json()).toMatchObject({ code: 'unimplemented' })
})

it('checks lifecycle bounds and data options', async () => {
  const { app } = await setup()
  const large = await e2bListener(app).inject({
    method: 'POST',
    url: CREATE,
    headers: KEY,
    payload: { templateID: 'x'.repeat(1024 ** 2) },
  })
  expect(large.statusCode, large.body).toBe(413)
  expect(app.registry.list()).toEqual([])

  const sandbox = await create(app)
  const viaBase = await e2bListener(app).inject({
    method: 'POST',
    url: `${CREATE}/${sandbox.sandboxID}/connect`,
    headers: KEY,
    payload: { timeout: 300, memory: false },
  })
  expect(viaBase.statusCode, viaBase.body).toBe(501)
  const headers = dataHeaders(sandbox)
  const wrong = { ...headers, 'x-access-token': 'forged-token' }
  expect((await e2bListener(app).inject({ url: '/health', headers: wrong })).statusCode).toBe(502)
  expect(
    (
      await e2bListener(app).inject({
        url: '/health',
        headers: { ...wrong, 'e2b-sandbox-id': 'missing' },
      })
    ).statusCode,
  ).toBe(502)

  const root = await e2bListener(app).inject({ url: '/files?path=sample&username=root', headers })
  expect(root.statusCode).toBe(400)
  expect(root.body).toContain('default sandbox user')
  const write = await e2bListener(app).inject({
    method: 'POST',
    url: '/files?path=sample',
    headers: { ...headers, 'x-metadata-label': 'data' },
  })
  expect(write.statusCode, write.body).toBe(501)
  expect((await e2bListener(app).inject({ url: '/files?path=sample', headers })).statusCode).toBe(
    404,
  )
})

describe('E2B body reads', () => {
  it.each([
    ['kill', '/files?path=fixture'],
    ['expiry', START],
    ['shutdown', START],
  ] as const)('returns a refusal on %s before the incoming body ends', async (event, path) => {
    const { app } = await setup()
    let begin = (): void => undefined
    const reading = new Promise<void>((resolve) => {
      begin = resolve
    })
    e2bListener(app).addHook('preHandler', (req, _reply, done) => {
      if (req.url === path) begin()
      done()
    })
    const sandbox = await create(app)
    const isCommand = path === START
    const headers = {
      ...dataHeaders(sandbox),
      'content-type': isCommand ? CONNECT_STREAM : 'multipart/form-data; boundary=partial',
    }
    const prefix = isCommand
      ? Buffer.alloc(4)
      : Buffer.from('--partial\r\nContent-Disposition: form-data; name="file"\r\n\r\n')
    const address = await e2bListener(app).listen({ host: '127.0.0.1', port: 0 })
    const client = request(address + path, { method: 'POST', headers })
    client.setTimeout(3000, () => client.destroy(new Error('streaming request timed out')))
    const reply = new Promise<IncomingMessage>((resolve, reject) => {
      client.once('response', resolve)
      client.once('error', reject)
    })
    void reply.catch(() => undefined)
    let shutdown: Promise<void> | undefined
    try {
      client.write(prefix)
      await reading
      if (event === 'kill') {
        const killed = await e2bListener(app).inject({
          method: 'DELETE',
          url: `/sandboxes/${sandbox.sandboxID}`,
          headers: KEY,
        })
        expect(killed.statusCode).toBe(204)
      } else if (event === 'expiry') {
        const expired = await e2bListener(app).inject({
          method: 'POST',
          url: `/sandboxes/${sandbox.sandboxID}/timeout`,
          headers: KEY,
          payload: { timeout: 0 },
        })
        expect(expired.statusCode).toBe(204)
      } else {
        shutdown = app.close()
      }
      const response = await reply
      expect(response.statusCode).toBe(401)
      expect(response.headers.connection).toBe('close')
      expect(JSON.parse((await buffer(response)).toString())).toMatchObject({
        code: isCommand ? 'unauthenticated' : 401,
      })
    } finally {
      client.destroy()
      await shutdown
    }
  })
})
