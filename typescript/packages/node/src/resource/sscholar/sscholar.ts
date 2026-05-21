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
  HttpSSCholarDriver,
  PathSpec,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  type SSCholarConfig,
  type SSCholarConfigResolved,
  type SSCholarDriver,
  SSCHOLAR_PAPER_COMMANDS,
  SSCHOLAR_PAPER_OPS,
  SSCHOLAR_PAPER_PROMPT,
  SSCholarAccessor,
  resolveSSCholarConfig,
  resolveSSCholarPaperGlob,
  sscholarPaperRead,
  sscholarPaperReaddir,
  sscholarPaperStat,
} from '@struktoai/mirage-core'

export interface SSCholarPaperResourceOptions {
  config?: SSCholarConfig
  prefix?: string
  driver?: SSCholarDriver
}

export class SSCholarPaperResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.SSCHOLAR_PAPER
  readonly isRemote: boolean = true
  readonly indexTtl: number = 0
  readonly prompt: string
  readonly config: SSCholarConfigResolved
  readonly driver: SSCholarDriver
  readonly accessor: SSCholarAccessor

  constructor(options: SSCholarPaperResourceOptions | SSCholarConfig = {}) {
    super()
    const opts: SSCholarPaperResourceOptions =
      'config' in options || 'driver' in options || 'prefix' in options
        ? options
        : { config: options as SSCholarConfig }
    this.config = resolveSSCholarConfig(opts.config ?? {})
    this.driver =
      opts.driver ??
      new HttpSSCholarDriver({ baseUrl: this.config.baseUrl, apiKey: this.config.apiKey })
    this.accessor = new SSCholarAccessor(this.driver, this.config)
    this.prompt = SSCHOLAR_PAPER_PROMPT.replace('{prefix}', opts.prefix ?? '')
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  ops(): readonly RegisteredOp[] {
    return SSCHOLAR_PAPER_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return SSCHOLAR_PAPER_COMMANDS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return sscholarPaperRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return sscholarPaperReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return sscholarPaperStat(this.accessor, p, this.index)
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
    return resolveSSCholarPaperGlob(this.accessor, effective, this.index)
  }
}
