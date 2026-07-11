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

import { existsSync, readFileSync } from 'node:fs'
import { pidFilePath } from '@struktoai/mirage-server'
import type { Command } from 'commander'
import { makeClient } from './client.ts'
import { emit, fail, formatAge } from './output.ts'
import { loadDaemonSettings } from './settings.ts'

interface DaemonStatus {
  running: boolean
  pid: number | null
  url: string
  uptimeS?: number
  workspaces?: number
}

function formatStatus(d: DaemonStatus): string {
  if (!d.running) return `Daemon not running. URL: ${d.url}`
  const parts: string[] = [`Running. PID ${d.pid !== null ? String(d.pid) : '?'}`]
  if (d.uptimeS !== undefined) {
    parts.push(`uptime ${formatAge(Date.now() / 1000 - d.uptimeS)}`)
  }
  if (d.workspaces !== undefined) {
    parts.push(`${String(d.workspaces)} workspace${d.workspaces === 1 ? '' : 's'}`)
  }
  return parts.join(', ') + `. URL: ${d.url}`
}

function formatStop(d: { via?: string; pid?: number }): string {
  const via = d.via ?? '?'
  return `Stopped (via ${via}${d.pid !== undefined ? `, PID ${String(d.pid)}` : ''}).`
}

function formatRestart(d: { spawnedFresh?: boolean }): string {
  if (d.spawnedFresh === true) return 'Restarted (eager spawn).'
  return 'Restarted; next CLI command will auto-spawn.'
}

function formatKill(d: { killed: boolean; pid?: number | null }): string {
  if (d.killed) return `Killed PID ${String(d.pid ?? '?')}.`
  if (d.pid === null || d.pid === undefined) return 'Daemon not running.'
  return `Already gone (PID ${String(d.pid)}).`
}

function readPid(): number | null {
  const p = pidFilePath()
  if (!existsSync(p)) return null
  const text = readFileSync(p, 'utf-8').trim()
  const pid = Number(text)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    return false
  }
}

function buildClient() {
  return makeClient(loadDaemonSettings())
}

async function waitForUnreachable(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const c = buildClient()
    if (!(await c.isReachable(300))) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

export function registerDaemonCommands(program: Command): void {
  const d = program.command('daemon').description('Manage the daemon process lifecycle.')

  d.command('status')
    .description('Show daemon health, PID, uptime, workspace count.')
    .action(async () => {
      const pid = readPid()
      const c = buildClient()
      const url = c.settings.url
      try {
        const r = await c.request('GET', '/v1/health')
        if (r.status !== 200) {
          emit({ running: false, pid, url } as DaemonStatus, formatStatus)
          process.exit(1)
        }
        const body = (await r.json()) as Record<string, unknown>
        emit({ running: true, pid, url, ...body } as DaemonStatus, formatStatus)
      } catch {
        emit({ running: false, pid, url } as DaemonStatus, formatStatus)
        process.exit(1)
      }
    })

  d.command('stop')
    .description('Gracefully stop the daemon.')
    .option('--timeout <s>', 'Seconds to wait for graceful exit', '5')
    .action(async (opts: { timeout: string }) => {
      const timeoutMs = Number(opts.timeout) * 1000
      const c = buildClient()
      let r: Response
      try {
        r = await c.request('POST', '/v1/shutdown')
      } catch (err: unknown) {
        fail(`daemon not reachable: ${String(err)}`)
      }
      if (r.status >= 400) fail(`shutdown failed: ${await r.text()}`, 2)
      if (await waitForUnreachable(timeoutMs)) {
        emit({ stopped: true, via: 'graceful' }, formatStop)
        return
      }
      const pid = readPid()
      if (pid !== null && processAlive(pid)) {
        try {
          process.kill(pid, 'SIGTERM')
          emit({ stopped: true, via: 'sigterm', pid }, formatStop)
          return
        } catch {
          // fall through to fail
        }
      }
      fail(`daemon did not exit within ${opts.timeout}s and no live PID found`, 2)
    })

  d.command('restart')
    .description('Stop the daemon. Next CLI command auto-spawns a fresh one.')
    .option('--timeout <s>', 'Seconds to wait for graceful exit', '5')
    .option('--eager', 'Spawn a fresh daemon immediately')
    .action(async (opts: { timeout: string; eager?: boolean }) => {
      const timeoutMs = Number(opts.timeout) * 1000
      try {
        await buildClient().request('POST', '/v1/shutdown')
      } catch {
        // already unreachable; fall through to pid cleanup
      }
      if (!(await waitForUnreachable(timeoutMs))) {
        const pid = readPid()
        if (pid !== null && processAlive(pid)) {
          try {
            process.kill(pid, 'SIGTERM')
          } catch {
            // process may have exited between checks
          }
        }
      }
      if (opts.eager === true) {
        await buildClient().ensureRunning({ allowSpawn: true })
        emit({ restarted: true, spawnedFresh: true }, formatRestart)
        return
      }
      emit(
        {
          restarted: true,
          spawnedFresh: false,
          note: 'next workspace create will auto-spawn',
        },
        formatRestart,
      )
    })

  d.command('kill')
    .description('SIGKILL the daemon. Last resort -- skips graceful shutdown.')
    .action(() => {
      const pid = readPid()
      if (pid === null) {
        emit({ killed: false, reason: 'no daemon running', pid: null }, formatKill)
        return
      }
      if (!processAlive(pid)) {
        emit({ killed: false, reason: 'process already gone', pid }, formatKill)
        return
      }
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        emit({ killed: false, reason: 'process gone', pid }, formatKill)
        return
      }
      emit({ killed: true, pid }, formatKill)
    })
}
