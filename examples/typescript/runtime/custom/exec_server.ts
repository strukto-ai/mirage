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
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

// A stand-in for the execution service, so the example runs on one machine.
// POST /run takes {argv, stdin, files} with base64 bytes, runs argv in a
// fresh directory holding those files, and answers {stdout, stderr,
// exit_code, files} with the files the program created or changed. A
// dropped connection kills the program.

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

async function run(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const outcome = await execute(body, root, res)
    const changed: Record<string, string> = {}
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

function execute(body: RunRequest, cwd: string, res: ServerResponse): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const [program, ...args] = body.argv
    const proc = spawn(program ?? '', args, { cwd })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const dropped = (): void => {
      if (!res.writableFinished) proc.kill('SIGKILL')
    }
    res.on('close', dropped)
    proc.stdout.on('data', (c: Buffer) => out.push(c))
    proc.stderr.on('data', (c: Buffer) => err.push(c))
    // A program that exits without reading its input closes the pipe;
    // that is the program's choice, not a failure of the run.
    proc.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') reject(e)
    })
    proc.on('error', () => {
      res.off('close', dropped)
      resolve({ stdout: Buffer.alloc(0), stderr: Buffer.from(`${program}: not found\n`), code: 127 })
    })
    proc.on('close', (code) => {
      res.off('close', dropped)
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code: code ?? 1 })
    })
    proc.stdin.end(Buffer.from(body.stdin, 'base64'))
  })
}

/** Serve on a free localhost port; returns the server and its run URL. */
export async function start(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    run(req, res).catch((e: unknown) => {
      res.statusCode = 500
      res.end(String(e))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}/run` }
}
