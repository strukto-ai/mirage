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

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createPlainServer } from 'node:http'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Workspace } from '../../../workspace.ts'

// A server whose certificate is its own: curl verifies and refuses it, and
// -k skips the check, as curl 8.14.1 does. openssl mints the certificate,
// since node cannot sign one.
const hasOpenssl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0

describe.skipIf(!hasOpenssl)('curl -k against a self-signed server', () => {
  let dir = ''
  let server: Server
  let url = ''

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mirage-tls-'))
    const minted = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ].concat(['-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')]),
      { stdio: 'ignore' },
    )
    expect(minted.status).toBe(0)
    server = createServer(
      { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('secure\n')
      },
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['curl -sS URL', 7, ''],
    ['curl -k -sS URL', 0, 'secure\n'],
    ['curl --insecure -sS URL', 0, 'secure\n'],
  ])('%s', async (line, exitCode, stdout) => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    try {
      const r = await ws.shell(line.replace('URL', url))
      expect([r.exitCode, new TextDecoder().decode(r.stdout)]).toEqual([exitCode, stdout])
    } finally {
      await ws.close()
    }
  })
})

// curl and wget send only the headers they name: none of the Accept,
// Accept-Encoding, Accept-Language, Sec-Fetch-Mode and User-Agent fetch adds
// on its own reaches the server (curl 8.14.1, wget 1.25.0). Connection is the
// transport's own.
describe('the headers curl and wget send', () => {
  const plain = createPlainServer((req, res) => {
    const seen = Object.entries(req.headers)
      .filter(([name]) => name !== 'host' && name !== 'connection')
      .map(([name, value]) => `${name}=${String(value)}`)
      .sort()
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(seen.map((line) => `${line}\n`).join(''))
  })
  let url = ''

  beforeAll(async () => {
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${String((plain.address() as AddressInfo).port)}/`
  })

  afterAll(async () => {
    await new Promise((resolve) => plain.close(resolve))
  })

  it.each([
    ['curl -s URL', 'accept=*/*\nuser-agent=curl/8.14.1\n'],
    ["curl -s -A '' URL", 'accept=*/*\n'],
    ["curl -s -H 'User-Agent:' -H 'Accept:' URL", ''],
    [
      "curl -s -H 'Accept-Language: en' URL",
      'accept-language=en\naccept=*/*\nuser-agent=curl/8.14.1\n',
    ],
    ['wget -qO- URL', 'accept-encoding=identity\naccept=*/*\nuser-agent=Wget/1.25.0\n'],
  ])('%s', async (line, stdout) => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    try {
      const r = await ws.shell(line.replace('URL', url))
      expect([r.exitCode, new TextDecoder().decode(r.stdout)]).toEqual([0, stdout])
    } finally {
      await ws.close()
    }
  })
})
