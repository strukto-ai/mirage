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

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { OpsRegistry } from '../../../../ops/registry.ts'
import { createShellParser } from '../../../../shell/parse/index.ts'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GH } from '../gh/index.ts'
import { GitError } from './errors.ts'
import { GIT } from './index.ts'
import { displayUrl, extraHeaders, parseAdvertisement, pktLine, pktLines } from './transport.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@example.com',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@example.com',
}
const INFO_REFS = '/repo.git/info/refs?service=git-upload-pack'
const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let tmp: string
let server: Server
let url: string

/**
 * git's own smart HTTP server, as a CGI behind a local listener.
 *
 * @param root the directory holding the served repositories
 * @param renames ref names rewritten in the advertisement, each to one of the
 *   same length so the pkt-line lengths still hold
 * @param seen collects each request's method and Authorization header
 */
function backend(
  root: string,
  renames: readonly [string, string][] = [],
  seen: [string, string | null][] = [],
): Server {
  return createServer((req, res) => {
    seen.push([req.method ?? 'GET', req.headers.authorization ?? null])
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const parsed = new URL(req.url ?? '/', 'http://localhost')
      const body = Buffer.concat(chunks)
      const done = spawnSync('git', ['http-backend'], {
        input: body,
        env: {
          ...ENV,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: parsed.pathname,
          QUERY_STRING: parsed.search.slice(1),
          REQUEST_METHOD: req.method ?? 'GET',
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          CONTENT_LENGTH: String(body.length),
          REMOTE_ADDR: '127.0.0.1',
        },
      })
      const out = done.stdout
      const split = out.indexOf('\r\n\r\n')
      let status = 200
      for (const line of out.subarray(0, split).toString().split('\r\n')) {
        const colon = line.indexOf(':')
        const name = line.slice(0, colon)
        const value = line.slice(colon + 1).trim()
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0])
        else if (name) res.setHeader(name, value)
      }
      let payload = out.subarray(split + 4)
      if (req.method === 'GET')
        for (const [old, renamed] of renames)
          payload = Buffer.from(payload.toString('latin1').replaceAll(old, renamed), 'latin1')
      res.statusCode = status
      res.end(payload)
    })
  })
}

/**
 * A listener that sends the ref advertisement on to another origin. The
 * Location is built from constants alone, never from the request, and any
 * other path is a 404.
 */
function redirector(target: string): Server {
  return createServer((req, res) => {
    const known = req.url === INFO_REFS
    res.statusCode = known ? 302 : 404
    if (known) res.setHeader('Location', `${target}${INFO_REFS}`)
    res.end()
  })
}

/** Start a server on a free local port; resolves with its origin. */
async function listen(listener: Server): Promise<string> {
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${String((listener.address() as AddressInfo).port)}`
}

/** A fresh bare repository under `<tmp>/<name>/repo.git`, one commit and tag v1 on main. */
function served(name: string, extra: string): void {
  execFileSync(
    'bash',
    [
      '-ec',
      `git init -q -b main ${name}-work && cd ${name}-work && echo one > a && git add a && ` +
        `git commit -qm first && git tag v1 && git clone -q --bare . ../${name}/repo.git && ` +
        `cd ../${name}/repo.git && ${extra}`,
    ],
    { cwd: tmp, env: ENV, stdio: 'ignore' },
  )
}

async function workspace(): Promise<Workspace> {
  const registry = new OpsRegistry()
  const ram = new RAMVFS()
  registry.registerVfs(ram)
  const parser = await createShellParser({ engineWasm, grammarWasm })
  const ws = new Workspace(
    { '/w': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  ws.registerCli('git', GIT)
  return ws
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mirage-http-'))
  execFileSync(
    'bash',
    [
      '-ec',
      `git init -q -b main work && cd work && echo one > a && git add a && git commit -qm first && ` +
        `git tag -a -m t v1 && echo two > a && git commit -qam second && ` +
        `git clone -q --bare . ../srv/repo.git`,
    ],
    { cwd: tmp, env: ENV, stdio: 'ignore' },
  )
  server = backend(join(tmp, 'srv'))
  url = `${await listen(server)}/repo.git`
})

afterAll(() => {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
})

it('round-trips pkt-lines with flushes', () => {
  const stream = new Uint8Array([...pktLine('one\n'), ...ENC.encode('0000'), ...pktLine('two')])
  expect([...pktLines(stream)].map((line) => (line === null ? null : DEC.decode(line)))).toEqual([
    'one\n',
    null,
    'two',
  ])
})

it("refuses a bad length as git's protocol error", () => {
  expect(() => [...pktLines(ENC.encode('zz00'))]).toThrow(GitError)
  expect(() => [...pktLines(ENC.encode('zz00'))]).toThrow('bad line length character: zz00')
})

it('reads refs, peeled tags and the HEAD symref off an advertisement', () => {
  const [oid, tag, peeled] = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]
  const adv = parseAdvertisement([
    ENC.encode(`${oid} HEAD\0side-band-64k symref=HEAD:refs/heads/main\n`),
    ENC.encode(`${oid} refs/heads/main\n`),
    ENC.encode(`${tag} refs/tags/v1\n`),
    ENC.encode(`${peeled} refs/tags/v1^{}\n`),
    null,
  ])
  expect([...adv.refs]).toEqual([
    ['HEAD', oid],
    ['refs/heads/main', oid],
    ['refs/tags/v1', tag],
  ])
  expect([...adv.peeled]).toEqual([['refs/tags/v1', peeled]])
  expect(adv.head).toBe('refs/heads/main')
})

it('reads an empty repository as advertising nothing', () => {
  const line = ENC.encode(`${'0'.repeat(40)} capabilities^{}\0agent=git/2\n`)
  expect(parseAdvertisement([line, null]).refs.size).toBe(0)
})

it.each([
  ['https://user:token@github.com/o/r.git', 'https://github.com/o/r'],
  ['https://github.com/o/r/', 'https://github.com/o/r'],
  ['/w/src/.git', '/w/src/'],
  ['../src', '../src'],
])('displays %s without credentials or the git suffix', (given, expected) => {
  expect(displayUrl(given)).toBe(expected)
})

it('splits extra headers, later ones winning', () => {
  expect(
    extraHeaders(['Authorization: Bearer a', 'X-A:1', 'Authorization: Bearer b', 'broken']),
  ).toEqual({ Authorization: 'Bearer b', 'X-A': '1' })
})

it('clones and fetches over smart http', async () => {
  const ws = await workspace()
  let result = await ws.shell(`cd /w && git clone ${url} c`)
  expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([0, "Cloning into 'c'...\n"])
  result = await ws.shell('cd /w/c && git log --format=%s')
  expect(DEC.decode(result.stdout)).toBe('second\nfirst\n')
  result = await ws.shell("cd /w/c && git for-each-ref --format='%(refname)'")
  expect(DEC.decode(result.stdout)).toBe(
    'refs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\nrefs/tags/v1\n',
  )
  execFileSync(
    'bash',
    [
      '-ec',
      'echo three > a && git commit -qam third && git tag v2 && git push -q ../srv/repo.git main v2',
    ],
    { cwd: join(tmp, 'work'), env: ENV, stdio: 'ignore' },
  )
  result = await ws.shell('cd /w/c && git fetch')
  const lines = DEC.decode(result.stderr).split('\n')
  expect(lines[0]).toBe(`From ${displayUrl(url)}`)
  expect(lines[2]).toBe(' * [new tag]         v2         -> v2')
  result = await ws.shell('cd /w/c && git log -1 --format=%s origin/main')
  expect(DEC.decode(result.stdout)).toBe('third\n')
})

it('says a missing http repository is not found and removes the clone', async () => {
  const ws = await workspace()
  const result = await ws.shell(`cd /w && git clone ${url}/nope.git m`)
  const left = await ws.shell('test -e /w/m || echo removed')
  expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([
    128,
    `Cloning into 'm'...\nfatal: repository '${url}/nope.git/' not found\n`,
  ])
  expect(DEC.decode(left.stdout)).toBe('removed\n')
})

it('ignores a ref named outside the repository', async () => {
  served('funny', 'git tag abcdefghijklmnop main && git branch wxyz main')
  const funny = backend(join(tmp, 'funny'), [
    ['refs/tags/abcdefghijklmnop', 'refs/tags/../../../../outs'],
    ['refs/heads/wxyz', 'refs/heads/..yz'],
  ])
  const origin = await listen(funny)
  try {
    const ws = await workspace()
    const cloned = await ws.shell(`cd /w && git clone ${origin}/repo.git c`)
    const fetched = await ws.shell('cd /w/c && git fetch')
    const refs = await ws.shell("cd /w/c && git for-each-ref --format='%(refname)'")
    const outside = await ws.shell('test -e /w/outs || echo absent')
    expect([cloned.exitCode, DEC.decode(cloned.stderr)]).toEqual([
      0,
      "Cloning into 'c'...\n" +
        "error: * Ignoring funny ref 'refs/remotes/origin/..yz' locally\n" +
        "error: * Ignoring funny ref 'refs/tags/../../../../outs' locally\n",
    ])
    expect([fetched.exitCode, DEC.decode(fetched.stderr)]).toEqual([
      0,
      "error: * Ignoring funny ref 'refs/remotes/origin/..yz' locally\n",
    ])
    expect(DEC.decode(refs.stdout)).toBe(
      'refs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\nrefs/tags/v1\n',
    )
    expect(DEC.decode(outside.stdout)).toBe('absent\n')
  } finally {
    funny.close()
  }
})

it('keeps url credentials with the origin they were typed for', async () => {
  served('hop', 'true')
  const seen: [string, string | null][] = []
  const target = backend(join(tmp, 'hop'), [], seen)
  const hop = redirector(await listen(target))
  const origin = await listen(hop)
  try {
    const ws = await workspace()
    const result = await ws.shell(
      `cd /w && git clone ${origin.replace('://', '://me:secret@')}/repo.git c`,
    )
    expect(result.exitCode).toBe(0)
    expect(seen).toEqual([
      ['GET', null],
      ['POST', null],
    ])
  } finally {
    hop.close()
    target.close()
  }
})

it('sends the gh token only as authorization on gh repo clone', async () => {
  served('gh', 'true')
  const seen: [string, string | null][] = []
  const listener = backend(tmp, [], seen)
  const base = await listen(listener)
  try {
    const ws = await workspace()
    ws.registerCli('gh', GH, { token: 't0k', base_url: base })
    const result = await ws.shell('cd /w && gh repo clone gh/repo c -- -q')
    expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([0, ''])
    const log = await ws.shell('cd /w/c && git log --format=%s')
    expect(DEC.decode(log.stdout)).toBe('first\n')
    const config = DEC.decode((await ws.shell('cat /w/c/.git/config')).stdout)
    expect(config).toContain(`url = ${base}/gh/repo.git`)
    expect(config).not.toContain('t0k')
    const auth = `Basic ${btoa('x-access-token:t0k')}`
    expect(seen).toEqual([
      ['GET', auth],
      ['POST', auth],
    ])
  } finally {
    listener.close()
  }
})
