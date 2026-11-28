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
import { DatabricksVolumeAccessor } from '../../src/accessor/databricks_volume.ts'
import { PathSpec } from '../../src/types.ts'
import { mountKey } from '../../src/utils/key_prefix.ts'
import { DatabricksVolumeConfig } from '../../src/vfs/databricks_volume/config.ts'
import { parseConfigWithSchema } from '../../src/vfs/secrets.ts'
import { KitRun, runToken } from './kit_fake.ts'

export const ROOT = '/Volumes/main/default/agent_files/root'
export const FILES = '/api/2.0/fs/files/*tail'
export const DIRS = '/api/2.0/fs/directories/*tail'
export const FILES_PREFIX = '/api/2.0/fs/files'
export const DIRS_PREFIX = '/api/2.0/fs/directories'
// A fixed epoch, so a test's times are the same on every run.
const EPOCH = '2023-11-14T22:13:20Z'
const TENANT = 'volume'

/** A mount path under `prefix`, as a backend op takes it. */
export function spec(virtual: string, prefix = '/volume'): PathSpec {
  return PathSpec.fromStrPath(virtual, mountKey(virtual, prefix))
}

/** A volume path as a request path spells it, each segment escaped. */
function escaped(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * One Unity Catalog volume on the integ Databricks fake, and the writes a
 * test arranges it by.
 *
 * A mount's host is a bare origin, so it cannot carry a run's path; the
 * access token names the run instead (`runToken`).
 */
export class DatabricksVolume {
  readonly run: KitRun
  readonly token: string

  constructor(readonly origin: string) {
    const name = randomUUID().replaceAll('-', '')
    this.token = runToken(name, TENANT)
    this.run = new KitRun(origin, { Authorization: `Bearer ${this.token}` }, name)
  }

  /** Start the run afresh, its clock at a fixed epoch. */
  async reset(): Promise<void> {
    await this.run.call('POST', '/reset', { json: { epoch: EPOCH, tenants: [TENANT] } })
  }

  /** A mount config's fields for the volume, rooted at `root` unless `overrides` say otherwise. */
  fields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      catalog: 'main',
      schema: 'default',
      volume: 'agent_files',
      root_path: '/root',
      host: this.origin,
      token: this.token,
      ...overrides,
    }
  }

  /** A mount config for the volume. */
  config(overrides: Record<string, unknown> = {}): DatabricksVolumeConfig {
    return parseConfigWithSchema(DatabricksVolumeConfig, this.fields(overrides))
  }

  /** A Mirage accessor on the volume. */
  accessor(overrides: Record<string, unknown> = {}): DatabricksVolumeAccessor {
    return new DatabricksVolumeAccessor(this.config(overrides))
  }

  /** Write a file, its directories made on the way, as Databricks' Files API does. */
  async put(path: string, data: string | Uint8Array): Promise<void> {
    const body = typeof data === 'string' ? new TextEncoder().encode(data) : data
    await this.run.call('PUT', `${FILES_PREFIX}${escaped(path)}?overwrite=true`, { body })
  }

  /** Make a directory and those above it. */
  async mkdir(path: string): Promise<void> {
    await this.run.call('PUT', `${DIRS_PREFIX}${escaped(path)}`)
  }

  /** Remove an empty directory. */
  async rmdir(path: string): Promise<void> {
    await this.run.call('DELETE', `${DIRS_PREFIX}${escaped(path)}`)
  }

  /**
   * Mark a file last written `ms` milliseconds after the epoch, a state no
   * request makes: the Files API stamps each write with now. The run is loaded
   * back afterwards, so a recording of its requests starts after this.
   */
  async setModified(path: string, ms: number): Promise<void> {
    await this.run.execute(
      'UPDATE DatabricksNode SET lastModified = ? WHERE tenant = ? AND path = ?',
      ms,
      TENANT,
      path,
    )
  }

  /** What a file holds now, as text. */
  async content(path: string): Promise<string> {
    return new TextDecoder().decode(await this.run.read(`${FILES_PREFIX}${escaped(path)}`))
  }

  /** The `Last-Modified` header Databricks answers a file's HEAD with. */
  async modified(path: string): Promise<string> {
    const res = await this.run.request('HEAD', `${FILES_PREFIX}${escaped(path)}`)
    if (res.status !== 200) throw new Error(`HEAD ${path} -> ${String(res.status)}`)
    return res.headers.get('last-modified') ?? ''
  }

  /** What Databricks answers for a listing of a directory. */
  listing(path: string): Promise<{ contents: Record<string, unknown>[] }> {
    return this.run.call('GET', `${DIRS_PREFIX}${escaped(path)}`)
  }

  /** Whether a file or a directory is at `path`. */
  async has(path: string): Promise<boolean> {
    for (const prefix of [FILES_PREFIX, DIRS_PREFIX]) {
      const res = await this.run.request('HEAD', `${prefix}${escaped(path)}`)
      if (res.status === 200) return true
    }
    return false
  }

  /** The volume path of each listed request to `route` (`FILES` or `DIRS`), in order. */
  async asked(method: string, route: string): Promise<string[]> {
    const prefix = route === FILES ? FILES_PREFIX : DIRS_PREFIX
    const listed = await this.run.call<{
      requests: { method: string; route: string; path: string }[]
    }>('GET', '/_kit/requests')
    return listed.requests
      .filter((r) => r.method === method && r.route === route)
      .map((r) => decodeURIComponent(r.path).slice(prefix.length))
  }
}
