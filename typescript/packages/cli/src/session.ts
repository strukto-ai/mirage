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

import type { Command } from 'commander'
import { makeClient } from './client.ts'
import { emit, handleResponse } from './output.ts'
import { loadDaemonSettings } from './settings.ts'

function buildClient() {
  return makeClient(loadDaemonSettings())
}

const MODES = new Set(['read', 'write', 'exec', 'r', 'rw', 'rwx'])

/**
 * Parse `-m` values like `/data:read` into a modes mapping. Modes are
 * the words ('read', 'write', 'exec') or their cumulative filesystem
 * aliases ('r', 'rw', 'rwx'). A bare prefix (no mode suffix) keeps
 * the mount's own configured mode. The mode is taken from the last
 * `:` so mount prefixes that contain colons still parse.
 */
export function parseMountModes(mounts: string[]): Record<string, string> {
  const modes: Record<string, string> = {}
  for (const item of mounts) {
    const idx = item.lastIndexOf(':')
    const mode = idx >= 0 ? item.slice(idx + 1) : ''
    if (idx >= 0 && MODES.has(mode)) {
      modes[item.slice(0, idx)] = mode
    } else {
      modes[item] = 'exec'
    }
  }
  return modes
}

export function registerSessionCommands(program: Command): void {
  const sess = program.command('session').description('Manage workspace sessions.')

  sess
    .command('create')
    .argument('<wsId>')
    .option('--id <sessionId>')
    .option(
      '-m, --mount <prefix>',
      "restrict session to a mount, optionally capping its mode: '/data:read' " +
        "(alias '/data:r'), '/scratch:rw', '/bin:rwx', or a bare '/data' to keep " +
        "the mount's own mode; repeatable",
      (value: string, prev: string[]) => prev.concat([value]),
      [] as string[],
    )
    .action(async (wsId: string, opts: { id?: string; mount?: string[] }) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const body: Record<string, unknown> = {}
      if (opts.id !== undefined) body.sessionId = opts.id
      if (opts.mount !== undefined && opts.mount.length > 0) {
        body.mounts = parseMountModes(opts.mount)
      }
      emit(
        await handleResponse(
          await c.request('POST', `/v1/workspaces/${wsId}/sessions`, {
            body: JSON.stringify(body),
          }),
        ),
      )
    })

  sess
    .command('list')
    .argument('<wsId>')
    .action(async (wsId: string) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      emit(await handleResponse(await c.request('GET', `/v1/workspaces/${wsId}/sessions`)))
    })

  sess
    .command('delete')
    .argument('<wsId>')
    .argument('<sessionId>')
    .action(async (wsId: string, sessionId: string) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      emit(
        await handleResponse(
          await c.request('DELETE', `/v1/workspaces/${wsId}/sessions/${sessionId}`),
        ),
      )
    })
}
