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
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatExplanation, registerShellCommand } from './shell.ts'

class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${String(code)}`)
  }
}

const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (tty === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY
  else Object.defineProperty(process.stdin, 'isTTY', tty)
})

describe('mirage shell', () => {
  it('cancels the job when Ctrl-C comes while the line is submitted', async () => {
    const seen: string[] = []
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const url = req.url ?? ''
        seen.push(`${req.method ?? ''} ${url}`)
        if (url.endsWith('/shell?background=true')) process.emit('SIGINT')
        const answer =
          url === '/v1/health'
            ? { status: 'ok' }
            : url.endsWith('/shell?background=true')
              ? { job_id: 'j1' }
              : { status: 'canceled', finished_at: 1, result: null, error: null }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const home = mkdtempSync(join(tmpdir(), 'mirage-shell-'))
    try {
      const { port } = server.address() as AddressInfo
      vi.stubEnv('MIRAGE_HOME', home)
      vi.stubEnv('MIRAGE_DAEMON_URL', `http://127.0.0.1:${String(port)}`)
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
      vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Exited(typeof code === 'number' ? code : undefined)
      })
      const program = new Command()
      registerShellCommand(program)
      const ran = program.parseAsync(['shell', '-w', 'w', '-c', 'sleep 20'], { from: 'user' })
      await expect(ran).rejects.toEqual(new Exited(130))
      expect(seen).toContain('DELETE /v1/jobs/j1')
    } finally {
      server.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
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
