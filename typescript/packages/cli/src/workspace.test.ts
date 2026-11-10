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

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin', 'mirage.js')
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('mirage workspace create', () => {
  it('refuses a config naming an unset variable with exit 2, before any request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-workspace-'))
    tempDirs.push(dir)
    const config = join(dir, 'missing.yaml')
    writeFileSync(config, 'mounts:\n  /:\n    vfs: ram\n    mode: ${MIRAGE_TEST_UNSET_VARIABLE}\n')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MIRAGE_HOME: dir,
      MIRAGE_DAEMON_URL: 'http://127.0.0.1:9',
    }
    delete env.MIRAGE_TEST_UNSET_VARIABLE
    const child = spawn(process.execPath, [BIN, 'workspace', 'create', config], { env })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(code).toBe(2)
    expect(stderr).toContain('MIRAGE_TEST_UNSET_VARIABLE')
  })

  it('sends a saved policy name as written and rebases a relative script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-workspace-'))
    tempDirs.push(dir)
    const config = join(dir, 'ws.yaml')
    writeFileSync(
      config,
      'mounts:\n  /:\n    vfs: ram\n' +
        'clis:\n  tally:\n    script: ./tally.py\n' +
        'profiles:\n  reviewer:\n    policy:\n      pre_command:\n' +
        '        - script: guard.py\n        - script: ./local.py\n',
    )
    const { url, seen, server } = await fakeServer()
    try {
      expect(await mirage(url, dir, 'create', config)).toBe(0)
      const body = JSON.parse(seen[0]?.body ?? '') as { config: unknown }
      expect(body.config).toEqual({
        mounts: { '/': { vfs: 'ram' } },
        clis: { tally: { script: join(dir, 'tally.py') } },
        profiles: {
          reviewer: {
            policy: { pre_command: [{ script: 'guard.py' }, { script: join(dir, 'local.py') }] },
          },
        },
      })
    } finally {
      server.close()
    }
  })
})

interface Seen {
  method: string
  url: string
  type: string
  body: string
}

/**
 * A server double: answers health, a snapshot, a load and an empty record
 * list, and keeps every other request.
 */
async function fakeServer(): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = []
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = req.url ?? ''
      if (url === '/v1/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
        return
      }
      seen.push({
        method: req.method ?? '',
        url,
        type: req.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('latin1'),
      })
      if (url.includes('/logs')) {
        if (url.includes('format=jsonl')) {
          res
            .writeHead(200, { 'content-type': 'application/x-ndjson' })
            .end('{"type":"command","command":"echo hi"}\n')
        } else {
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end('{"items":[],"next":"cursor"}')
        }
        return
      }
      // As the console answers a delete: no body.
      if (req.method === 'DELETE') {
        res.writeHead(204).end()
        return
      }
      if (req.method === 'GET' && /\/(lines|jobs|processes|machines)(\?|$)/.test(url)) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('[]')
        return
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/x-tar' }).end('TAR')
        return
      }
      const answer = url.endsWith('/snapshot')
        ? { id: 'w', key: 'a.tar', size: 3 }
        : { id: 'w2', mounts: [], sessions: [], created_at: 0 }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${String(port)}`, seen, server }
}

async function mirage(url: string, home: string, ...args: string[]): Promise<number | null> {
  return mirageWith({}, url, home, ...args)
}

async function mirageWith(
  extra: NodeJS.ProcessEnv,
  url: string,
  home: string,
  ...args: string[]
): Promise<number | null> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MIRAGE_WORKSPACE: '',
    MIRAGE_CONTEXT: '',
    ...extra,
    MIRAGE_HOME: home,
    MIRAGE_DAEMON_URL: url,
  }
  const child = spawn(process.execPath, [BIN, 'workspace', ...args], { env })
  return new Promise<number | null>((resolve) => child.on('close', resolve))
}

describe('mirage workspace create from a template', () => {
  it('sends the template name and the -w id, and needs one of a file or a template', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-template-'))
    tempDirs.push(dir)
    const { url, seen, server } = await fakeServer()
    try {
      expect(await mirage(url, dir, 'create', '--template', 'base', '-w', 'my-ws')).toBe(0)
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/workspaces' })
      expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ template: 'base', id: 'my-ws' })
      const config = join(dir, 'c.yaml')
      writeFileSync(config, 'mounts:\n  /ram:\n    vfs: ram\n')
      expect(await mirage(url, dir, 'create')).toBe(2)
      expect(await mirage(url, dir, 'create', config, '--template', 'base')).toBe(2)
      expect(seen).toHaveLength(1)
      expect(await mirage(url, dir, 'create', config, '--id', 'w2')).toBe(0)
      expect(JSON.parse(seen[1]?.body ?? '')).toMatchObject({ id: 'w2' })
    } finally {
      server.close()
    }
  })
})

describe('mirage workspace snapshot and load', () => {
  it('write the tar here, put a key in the store, and upload a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-snapshot-'))
    tempDirs.push(dir)
    const { url, seen, server } = await fakeServer()
    try {
      const out = join(dir, 'w.tar')
      expect(await mirage(url, dir, 'snapshot', 'w', out)).toBe(0)
      expect(readFileSync(out, 'utf8')).toBe('TAR')
      expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/workspaces/w/snapshot' })

      expect(await mirage(url, dir, 'snapshot', 'w', '--key', 'a.tar')).toBe(0)
      expect(seen[1]).toMatchObject({ method: 'POST', url: '/v1/workspaces/w/snapshot' })
      expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ key: 'a.tar' })

      expect(await mirage(url, dir, 'load', out, '--id', 'w2')).toBe(0)
      expect(seen[2]?.type).toContain('multipart/form-data')
      expect(seen[2]?.body).toContain('{"id":"w2"}')
      expect(seen[2]?.body).toContain('name="snapshot"')
      expect(seen[2]?.body).toContain('TAR')

      const config = join(dir, 'c.yaml')
      writeFileSync(config, 'mounts:\n  /ram:\n    vfs: ram\n')
      expect(await mirage(url, dir, 'load', '--key', 'a.tar', config)).toBe(0)
      const body = JSON.parse(seen[3]?.body ?? '') as { key: string; override: unknown }
      expect(body.key).toBe('a.tar')
      expect(body.override).toMatchObject({ mounts: { '/ram': { vfs: 'ram' } } })
    } finally {
      server.close()
    }
  })

  it('refuse a file and a key together, or neither, with exit 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-snapshot-'))
    tempDirs.push(dir)
    const { url, seen, server } = await fakeServer()
    try {
      expect(await mirage(url, dir, 'snapshot', 'w')).toBe(2)
      expect(await mirage(url, dir, 'snapshot', 'w', join(dir, 'x.tar'), '--key', 'k')).toBe(2)
      const config = join(dir, 'c.yaml')
      writeFileSync(config, 'mounts: {}\n')
      expect(await mirage(url, dir, 'load', '--key', 'a.tar', config, config)).toBe(2)
      expect(seen).toEqual([])
    } finally {
      server.close()
    }
  })
})

describe('mirage workspace set-profile', () => {
  it('refuses a file that is not a YAML mapping with exit 2, before any request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-profile-'))
    tempDirs.push(dir)
    const { url, seen, server } = await fakeServer()
    try {
      const profile = join(dir, 'profile.yaml')
      for (const text of ['', 'null\n', 'false\n', '0\n', '[]\n', 'commands: [\n']) {
        writeFileSync(profile, text)
        expect(await mirage(url, dir, 'set-profile', 'w', 'reader', profile)).toBe(2)
      }
      expect(seen).toEqual([])
    } finally {
      server.close()
    }
  })
})

describe('mirage workspace delete', () => {
  it('names the workspace it deleted when the server answers with no body', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mirage-delete-'))
    tempDirs.push(home)
    const { url, seen, server } = await fakeServer()
    try {
      const child = spawn(process.execPath, [BIN, 'workspace', 'delete', 'my-ws'], {
        env: { ...process.env, MIRAGE_HOME: home, MIRAGE_DAEMON_URL: url },
      })
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      expect(await new Promise<number | null>((resolve) => child.on('close', resolve))).toBe(0)
      expect(seen[0]).toMatchObject({ method: 'DELETE', url: '/v1/workspaces/my-ws' })
      expect(JSON.parse(stdout)).toEqual({ id: 'my-ws' })
    } finally {
      server.close()
    }
  })
})

describe('mirage workspace logs', () => {
  it.each([false, true])('uses the console contract with jsonl=%s', async (jsonl) => {
    const home = mkdtempSync(join(tmpdir(), 'mirage-logs-'))
    tempDirs.push(home)
    const { url, seen, server } = await fakeServer()
    try {
      const child = spawn(
        process.execPath,
        [
          BIN,
          'workspace',
          'logs',
          '-w',
          'w',
          '-s',
          's1',
          '--limit',
          '2',
          '--after',
          'opaque',
          ...(jsonl ? ['--jsonl'] : []),
        ],
        { env: { ...process.env, MIRAGE_HOME: home, MIRAGE_DAEMON_URL: url } },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
      expect(stderr).toBe('')
      expect(code).toBe(0)
      expect(seen[0]?.url).toBe(
        `/v1/workspaces/w/logs?limit=2&session=s1&after=opaque${jsonl ? '&format=jsonl' : ''}`,
      )
      if (jsonl) expect(stdout).toBe('{"type":"command","command":"echo hi"}\n')
      else expect(JSON.parse(stdout)).toEqual({ items: [], next: 'cursor' })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        }),
      )
    }
  })
})

// Each record list asks its route for the filters its options name, and
// leaves out the ones not given.
describe('mirage workspace list-lines, list-jobs and list-processes', () => {
  it('ask for what their options name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-records-'))
    tempDirs.push(dir)
    const { url, seen, server } = await fakeServer()
    try {
      expect(await mirage(url, dir, 'list-lines', '-w', 'w', '--state', 'running')).toBe(0)
      expect(await mirage(url, dir, 'list-jobs', '-w', 'w', '-s', 's1')).toBe(0)
      expect(await mirage(url, dir, 'list-jobs', '--workspace', 'w', '--line', 'line_1')).toBe(0)
      expect(
        await mirage(
          url,
          dir,
          'list-processes',
          '-w',
          'w',
          '--line',
          'line_1',
          '--state',
          'exited',
        ),
      ).toBe(0)
      expect(
        await mirage(
          url,
          dir,
          'list-processes',
          '-w',
          'w',
          '--session',
          's1',
          '--job',
          'j1',
          '--machine',
          'docker:t',
        ),
      ).toBe(0)
      expect(await mirage(url, dir, 'list-machines', '-w', 'w')).toBe(0)
      expect(seen.map((s) => [s.method, s.url])).toEqual([
        ['GET', '/v1/workspaces/w/lines?state=running'],
        ['GET', '/v1/workspaces/w/jobs?session_id=s1'],
        ['GET', '/v1/workspaces/w/jobs?line_id=line_1'],
        ['GET', '/v1/workspaces/w/processes?state=exited&line_id=line_1'],
        ['GET', '/v1/workspaces/w/processes?session_id=s1&job_id=j1&machine=docker%3At'],
        ['GET', '/v1/workspaces/w/machines'],
      ])
    } finally {
      server.close()
    }
  })

  it('read the current workspace, and take no workspace operand', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-records-'))
    tempDirs.push(dir)
    const { url, seen, server } = await fakeServer()
    try {
      for (const verb of ['list-lines', 'list-jobs', 'list-processes', 'list-machines']) {
        expect(await mirage(url, dir, verb)).toBe(2)
        expect(await mirage(url, dir, verb, 'w')).toBe(2)
        expect(await mirage(url, dir, verb, '--workspace_id', 'w')).toBe(2)
      }
      expect(seen).toEqual([])
      const current = { MIRAGE_WORKSPACE: 'cur' }
      for (const verb of ['list-lines', 'list-jobs', 'list-processes', 'list-machines'])
        expect(await mirageWith(current, url, dir, verb)).toBe(0)
      expect(seen.map((s) => s.url)).toEqual([
        '/v1/workspaces/cur/lines',
        '/v1/workspaces/cur/jobs',
        '/v1/workspaces/cur/processes',
        '/v1/workspaces/cur/machines',
      ])
    } finally {
      server.close()
    }
  })
})
