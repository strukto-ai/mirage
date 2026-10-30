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

import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

// A stand-in for the execution service, so the example runs on one machine.
// POST /run takes {argv, stdin, files} with base64 bytes, runs argv in a
// fresh directory holding those files, and answers {stdout, stderr,
// exit_code, files} with the files the program created or changed. Each run
// needs the token the service was started with, starts in its own process
// group, and a dropped connection kills the whole group.

interface RunRequest {
  argv: string[]
  stdin: string
  files: Record<string, string>
}

interface Outcome {
  stdout: Buffer
  stderr: Buffer
  code: number
}

async function run(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  // Watch for the caller leaving before any await, so a run it abandons
  // during setup never starts and one it abandons later is stopped.
  const run: { proc?: ChildProcess; gone: boolean } = { gone: false }
  res.on('close', () => {
    if (res.writableFinished) return
    run.gone = true
    if (run.proc?.pid !== undefined) stopGroup(run.proc.pid)
  })
  if (!sameToken(req.headers.authorization ?? '', `Bearer ${token}`)) {
    res.statusCode = 401
    res.end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const body = JSON.parse(Buffer.concat(chunks).toString()) as RunRequest
  const root = await mkdtemp(join(tmpdir(), 'exec-'))
  try {
    const sent = new Map<string, Buffer>()
    for (const [rel, data] of Object.entries(body.files)) {
      const bytes = Buffer.from(data, 'base64')
      sent.set(rel, bytes)
      await mkdir(dirname(join(root, rel)), { recursive: true })
      await writeFile(join(root, rel), bytes)
    }
    if (run.gone) return
    const outcome = await execute(body, root, run)
    const changed: Record<string, string> = Object.create(null) as Record<string, string>
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath, entry.name)
      const bytes = await readFile(path)
      const rel = relative(root, path)
      if (!sent.get(rel)?.equals(bytes)) changed[rel] = bytes.toString('base64')
    }
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        stdout: outcome.stdout.toString('base64'),
        stderr: outcome.stderr.toString('base64'),
        exit_code: outcome.code,
        files: changed,
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function execute(
  body: RunRequest,
  cwd: string,
  run: { proc?: ChildProcess; gone: boolean },
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const [program, ...args] = body.argv
    const proc = spawn(program ?? '', args, { cwd, detached: true })
    run.proc = proc
    const out: Buffer[] = []
    const err: Buffer[] = []
    proc.stdout.on('data', (c: Buffer) => out.push(c))
    proc.stderr.on('data', (c: Buffer) => err.push(c))
    // A program that exits without reading its input closes the pipe;
    // that is the program's choice, not a failure of the run.
    proc.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') reject(e)
    })
    proc.on('error', () => {
      resolve({ stdout: Buffer.alloc(0), stderr: Buffer.from(`${program}: not found\n`), code: 127 })
    })
    proc.on('exit', () => {
      // Anything the program left running in its group goes with it, so
      // no stray child holds the output pipes open.
      if (proc.pid !== undefined) stopGroup(proc.pid)
    })
    proc.on('close', (code) => {
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code: code ?? 1 })
    })
    proc.stdin.end(Buffer.from(body.stdin, 'base64'))
  })
}

function stopGroup(pid: number): void {
  // The program and anything it started share the group, so one kill
  // stops them all; a group that already exited has nothing to stop.
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
  }
}

function sameToken(got: string, want: string): boolean {
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Serve on a free localhost port; returns the server, its run URL and the
 * token a caller must send.
 */
export async function start(): Promise<{ server: Server; url: string; token: string }> {
  const token = randomBytes(32).toString('base64url')
  const server = createServer((req, res) => {
    run(req, res, token).catch((e: unknown) => {
      // The error stays in the service's log; the caller gets a fixed
      // plain-text body, never the error's own text.
      console.error('run failed:', e)
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.statusCode = 500
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('run failed\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}/run`, token }
}
