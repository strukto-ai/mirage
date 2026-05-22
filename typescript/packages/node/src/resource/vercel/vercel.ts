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

import {
  BaseResource,
  type FileStat,
  HttpVercelDriver,
  PathSpec,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  type VercelConfig,
  type VercelConfigResolved,
  type VercelDriver,
  VERCEL_COMMANDS,
  VERCEL_OPS,
  VERCEL_PROMPT,
  VercelAccessor,
  resolveVercelConfig,
  resolveVercelGlob,
  vercelRead,
  vercelReaddir,
  vercelStat,
} from '@struktoai/mirage-core'

export interface VercelResourceOptions {
  config?: VercelConfig
  prefix?: string
  driver?: VercelDriver
}

export class VercelResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.VERCEL
  readonly isRemote: boolean = true
  readonly indexTtl: number = 60
  readonly prompt: string
  readonly config: VercelConfigResolved
  readonly driver: VercelDriver
  readonly accessor: VercelAccessor

  constructor(options: VercelResourceOptions | VercelConfig = {}) {
    super()
    const opts: VercelResourceOptions =
      'config' in options || 'driver' in options || 'prefix' in options
        ? options
        : { config: options as VercelConfig }
    this.config = resolveVercelConfig(opts.config ?? {})
    this.driver =
      opts.driver ??
      new HttpVercelDriver({
        baseUrl: this.config.baseUrl,
        token: this.config.token,
        teamId: this.config.teamId,
      })
    this.accessor = new VercelAccessor(this.driver, this.config)
    this.prompt = VERCEL_PROMPT.replace('{prefix}', opts.prefix ?? '')
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  ops(): readonly RegisteredOp[] {
    return VERCEL_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return VERCEL_COMMANDS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return vercelRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return vercelReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return vercelStat(this.accessor, p, this.index)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            p.prefix !== ''
              ? p
              : new PathSpec({
                  original: p.original,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  prefix,
                }),
          )
        : paths
    return resolveVercelGlob(this.accessor, effective, this.index)
  }
}
