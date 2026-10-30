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

import { type Counter, type Meter, metrics, type ObservableResult } from '@opentelemetry/api'
import { ExecutionStatus } from '@struktoai/mirage-core/execution/types'
import type { WorkspaceRegistry } from './registry.ts'

export const METER_NAME = 'mirage.server'

const RUNNING: ReadonlySet<ExecutionStatus> = new Set([
  ExecutionStatus.RUNNING,
  ExecutionStatus.STOPPING,
])
const registries = new Set<WorkspaceRegistry>()
let held: Counter | null = null

/**
 * Report `registry` through OpenTelemetry's global meter provider, until
 * the returned function is called as the app closes. Mirage records through
 * the OpenTelemetry API only, so nothing is sent until the process sets up
 * an SDK (a `MeterProvider` registered before the app is built); the
 * exporter it picks decides where the numbers go. Mirrors Python's
 * `register_metrics`.
 */
export function registerMetrics(registry: WorkspaceRegistry): () => void {
  registries.add(registry)
  instruments()
  return () => {
    registries.delete(registry)
  }
}

/**
 * Count a request the server refused for one of its own limits:
 * rate_limit, max_sessions, max_workspaces or draining.
 */
export function refused(reason: string): void {
  instruments().add(1, { reason })
}

/** The server's instruments, made once on the global meter provider; the refusal counter. */
function instruments(): Counter {
  held ??= create(metrics.getMeter(METER_NAME))
  return held
}

/** Make the server's instruments on `meter`, answering the refusal counter. */
export function create(meter: Meter): Counter {
  meter
    .createObservableUpDownCounter('mirage.workspace.count', {
      unit: '{workspace}',
      description: 'Workspaces the server holds.',
    })
    .addCallback(workspaces)
  meter
    .createObservableUpDownCounter('mirage.workspace.limit', {
      unit: '{workspace}',
      description: 'The most workspaces the server holds at once.',
    })
    .addCallback(limit)
  meter
    .createObservableUpDownCounter('mirage.session.count', {
      unit: '{session}',
      description: "Sessions across the server's workspaces.",
    })
    .addCallback(sessions)
  meter
    .createObservableUpDownCounter('mirage.job.running', {
      unit: '{job}',
      description: "Lines the server's API is running.",
    })
    .addCallback(running)
  meter
    .createObservableGauge('mirage.server.draining', {
      unit: '1',
      description: '1 while the server drains for shutdown, else 0.',
    })
    .addCallback(draining)
  return meter.createCounter('mirage.request.refused', {
    unit: '{request}',
    description: 'Requests refused for a server limit, by reason.',
  })
}

/** The workspaces held. */
function workspaces(result: ObservableResult): void {
  result.observe([...registries].reduce((sum, registry) => sum + registry.size(), 0))
}

/** The workspace cap, when one is set. */
function limit(result: ObservableResult): void {
  const caps = [...registries].flatMap((r) => (r.maxWorkspaces === null ? [] : [r.maxWorkspaces]))
  if (caps.length > 0) result.observe(caps.reduce((sum, cap) => sum + cap, 0))
}

/** The sessions across every workspace held. */
function sessions(result: ObservableResult): void {
  let count = 0
  for (const registry of registries) {
    for (const entry of registry.list()) count += entry.runner.ws.listSessions().length
  }
  result.observe(count)
}

/** The lines the API is running. */
function running(result: ObservableResult): void {
  let count = 0
  for (const registry of registries) {
    count += registry.jobs.list().filter((job) => RUNNING.has(job.status)).length
  }
  result.observe(count)
}

/** 1 while a server drains. */
function draining(result: ObservableResult): void {
  result.observe([...registries].some((r) => r.draining) ? 1 : 0)
}
