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

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatExplanation, registerShellCommand } from './shell.ts'

const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const exitCode = process.exitCode

afterEach(() => {
  process.exitCode = exitCode
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (tty === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY
  else Object.defineProperty(process.stdin, 'isTTY', tty)
})

describe('mirage shell', () => {
  it.each([false, true])(
    'uses the same foreground stream transport (json=%s)',
    async (jsonOutput) => {
      const seen: string[] = []
      const server = createServer((req, res) => {
        req.resume()
        req.on('end', () => {
          const url = req.url ?? ''
          seen.push(`${req.method ?? ''} ${url}`)
          if (url === '/v1/health') {
            res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
            return
          }
          res.writeHead(200, { 'content-type': 'application/x-ndjson' }).end(
            [
              { stream: 'stdout', data: Buffer.from([0xe2]).toString('base64') },
              { stream: 'stderr', data: Buffer.from('diagnostic\n').toString('base64') },
              { stream: 'stdout', data: Buffer.from([0x82, 0xac, 0xff, 0]).toString('base64') },
              {
                status: 'done',
                result: { kind: 'io', exit_code: 7, refusal: { reason: 'test' } },
                error: null,
              },
            ]
              .map((value) => JSON.stringify(value) + '\n')
              .join(''),
          )
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const home = mkdtempSync(join(tmpdir(), 'mirage-shell-'))
      const out: Buffer[] = []
      const err: Buffer[] = []
      const stdout = new Writable({
        write(data: Buffer, _encoding, done) {
          out.push(data)
          done()
        },
      })
      const stderr = new Writable({
        write(data: Buffer, _encoding, done) {
          err.push(data)
          done()
        },
      })
      try {
        const { port } = server.address() as AddressInfo
        vi.stubEnv('MIRAGE_HOME', home)
        vi.stubEnv('MIRAGE_DAEMON_URL', `http://127.0.0.1:${String(port)}`)
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
        vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as typeof process.stdout)
        vi.spyOn(process, 'stderr', 'get').mockReturnValue(stderr as typeof process.stderr)
        const program = new Command()
        registerShellCommand(program)
        await program.parseAsync(
          ['shell', '-w', 'w', '-c', 'test', ...(jsonOutput ? ['--json'] : [])],
          { from: 'user' },
        )
        expect(process.exitCode).toBe(7)
        expect(seen).toEqual(['GET /v1/health', 'POST /v1/workspaces/w/shell?stream=true'])
        if (jsonOutput) {
          expect(JSON.parse(Buffer.concat(out).toString())).toEqual({
            kind: 'io',
            exit_code: 7,
            refusal: { reason: 'test' },
            stdout: '€�\0',
            stderr: 'diagnostic\n',
          })
          expect(Buffer.concat(err).length).toBe(0)
        } else {
          expect(Buffer.concat(out)).toEqual(Buffer.from([0xe2, 0x82, 0xac, 0xff, 0]))
          expect(Buffer.concat(err).toString()).toBe('diagnostic\npolicy denied: test\n')
        }
      } finally {
        vi.restoreAllMocks()
        server.closeAllConnections()
        server.close()
        rmSync(home, { recursive: true, force: true })
      }
    },
  )
})

function command(text: string, outcome: string, reason = '', exitCode = 0) {
  return {
    type: 'command',
    text,
    outcome,
    exit_code: exitCode,
    reason,
    source: reason === '' ? '' : 'top',
    runtime: '',
    children: [],
  }
}

describe('mirage workspace explain', () => {
  it('prints the line as its tree', () => {
    const cat = command('cat /data/keys/a', 'deny', 'sealed', 1)
    const echo = {
      ...command('echo $(cat /data/keys/a)', 'allow'),
      children: [{ type: 'substitution', text: 'cat /data/keys/a', children: [cat] }],
    }
    const said = {
      line: 'ls | wc -l && echo $(cat /data/keys/a)',
      outcome: 'deny',
      reason: 'sealed',
      exit_code: 1,
      node: {
        type: 'line',
        text: 'ls | wc -l && echo $(cat /data/keys/a)',
        children: [
          {
            type: 'list',
            text: 'ls | wc -l && echo $(cat /data/keys/a)',
            children: [
              {
                type: 'pipeline',
                text: 'ls | wc -l',
                children: [command('ls', 'allow'), command('wc -l', 'allow')],
              },
              echo,
            ],
          },
        ],
      },
    }
    expect(formatExplanation(said).split('\n')).toEqual([
      'ls | wc -l && echo $(cat /data/keys/a)  [deny, exit 1: sealed]',
      '  list: ls | wc -l && echo $(cat /data/keys/a)',
      '    pipeline: ls | wc -l',
      '      ls  [allow]',
      '      wc -l  [allow]',
      '    echo $(cat /data/keys/a)  [allow]',
      '      substitution: cat /data/keys/a',
      '        cat /data/keys/a  [deny, exit 1: sealed]  top',
    ])
  })
})
