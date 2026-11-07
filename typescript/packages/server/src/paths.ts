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

import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ENV_HOME } from './env.ts'

export function mirageHome(env: Record<string, string | undefined> = process.env): string {
  const override = env[ENV_HOME]
  return override !== undefined && override !== '' ? resolve(override) : join(homedir(), '.mirage')
}

// No per-path env or config keys below: like docker's data-root and
// git's GIT_DIR, the home is the single configurable root and its
// layout is fixed.
export function pidFilePath(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (explicit !== undefined) return resolve(explicit)
  return join(mirageHome(env), 'daemon.pid')
}

export function stateRootPath(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (explicit !== undefined) return resolve(explicit)
  return join(mirageHome(env), 'state')
}

export function resourcesRootPath(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (explicit !== undefined) return resolve(explicit)
  return join(mirageHome(env), 'resources')
}

/**
 * This daemon's id, kept in `daemon-id` under the state root and made the
 * first time. A workspace's lease names the daemon that runs it, so a
 * daemon restarted on the same state root holds its workspaces again at
 * once. Daemons that start together on one root agree on one id: the first
 * to link its file in place wins, and the others read it. Mirrors Python's
 * `load_daemon_id`.
 */
export async function loadDaemonId(stateRoot: string): Promise<string> {
  const path = join(stateRoot, 'daemon-id')
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'ENOENT') throw err
  }
  await mkdir(stateRoot, { recursive: true })
  const draft = join(stateRoot, `daemon-id.${randomUUID().replaceAll('-', '')}`)
  await writeFile(draft, randomUUID().replaceAll('-', ''), 'utf8')
  try {
    await link(draft, path)
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'EEXIST') throw err
    console.debug(`daemon id already written at ${path}`)
  } finally {
    await unlink(draft)
  }
  return (await readFile(path, 'utf8')).trim()
}
