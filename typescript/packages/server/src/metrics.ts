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

import { ExecutionStatus } from '@struktoai/mirage-core/execution/types'
import type { ExecutionTable } from './jobs.ts'
import type { WorkspaceRegistry } from './registry.ts'

export const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

const RUNNING: ReadonlySet<ExecutionStatus> = new Set([
  ExecutionStatus.RUNNING,
  ExecutionStatus.STOPPING,
])

/**
 * The server's metrics in Prometheus's text format: workspaces, sessions,
 * running jobs, whether it drains, the responses it sent by status code,
 * and its resident memory. Mirrors Python's `render_metrics`.
 */
export function renderMetrics(
  registry: WorkspaceRegistry,
  jobs: ExecutionTable,
  uptime: number,
  responses: ReadonlyMap<number, number>,
): string {
  const lines = [
    ...metric('mirage_uptime_seconds', 'gauge', 'Seconds since the server started.', [
      ['', Math.round(uptime * 1000) / 1000],
    ]),
    ...metric('mirage_workspaces', 'gauge', 'Workspaces the server holds.', [
      ['', registry.size()],
    ]),
  ]
  if (registry.maxWorkspaces !== null) {
    lines.push(
      ...metric('mirage_max_workspaces', 'gauge', 'The most workspaces the server holds at once.', [
        ['', registry.maxWorkspaces],
      ]),
    )
  }
  const sessions = registry
    .list()
    .reduce((sum, entry) => sum + entry.runner.ws.listSessions().length, 0)
  const running = jobs.list().filter((job) => RUNNING.has(job.status)).length
  lines.push(
    ...metric('mirage_sessions', 'gauge', "Sessions across the server's workspaces.", [
      ['', sessions],
    ]),
    ...metric('mirage_jobs_running', 'gauge', "Lines the server's API is running.", [
      ['', running],
    ]),
    ...metric('mirage_draining', 'gauge', '1 while the server drains for shutdown, else 0.', [
      ['', registry.draining ? 1 : 0],
    ]),
    ...metric(
      'mirage_http_responses_total',
      'counter',
      'Responses the server sent, by status code.',
      [...responses.entries()]
        .sort(([a], [b]) => a - b)
        .map(([code, count]) => [`{code="${String(code)}"}`, count]),
    ),
    ...metric('process_resident_memory_bytes', 'gauge', 'Resident memory size in bytes.', [
      ['', process.memoryUsage().rss],
    ]),
  )
  return lines.join('\n') + '\n'
}

/** One metric's lines: its help, its type and each sample's labels and value. */
function metric(
  name: string,
  kind: string,
  about: string,
  samples: readonly (readonly [string, number])[],
): string[] {
  return [
    `# HELP ${name} ${about}`,
    `# TYPE ${name} ${kind}`,
    ...samples.map(([labels, value]) => `${name}${labels} ${String(value)}`),
  ]
}
