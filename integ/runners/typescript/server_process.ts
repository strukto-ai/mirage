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

import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { integRoot } from './harness.ts'

export interface PythonServer {
  endpoint: string
  close: () => Promise<void>
}

function pythonExecutable(): string {
  const configured = process.env.MIRAGE_PYTHON
  if (configured !== undefined && configured !== '') return configured
  const local = join(integRoot(), '..', 'python', '.venv', 'bin', 'python')
  try {
    accessSync(local)
    return local
  } catch {
    return process.platform === 'win32' ? 'python' : 'python3'
  }
}

function firstLine(child: ChildProcess, script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      const line = stdout.slice(0, newline).trim()
      if (line === '') reject(new Error(`${script} returned an empty endpoint`))
      else resolve(line)
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      reject(
        new Error(
          `${script} exited before startup (${String(code)}): ${stderr.trim() || 'no stderr'}`,
        ),
      )
    })
  })
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    once(child, 'exit'),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 2_000)
    }),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

export async function startPythonServer(
  script: string,
  extraEnv: Record<string, string> = {},
): Promise<PythonServer> {
  const root = join(integRoot(), '..')
  const child = spawn(pythonExecutable(), [join(integRoot(), 'server', script)], {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: join(root, 'python'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const endpoint = await firstLine(child, script)
    return { endpoint, close: () => stop(child) }
  } catch (error) {
    await stop(child)
    throw error
  }
}
