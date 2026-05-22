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
  HttpPostHogDriver,
  PathSpec,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  type PostHogConfig,
  type PostHogConfigResolved,
  type PostHogDriver,
  POSTHOG_COMMANDS,
  POSTHOG_OPS,
  POSTHOG_PROMPT,
  PostHogAccessor,
  posthogRead,
  posthogReaddir,
  posthogStat,
  resolvePostHogConfig,
  resolvePostHogGlob,
} from '@struktoai/mirage-core'

export interface PostHogResourceOptions {
  config?: PostHogConfig
  prefix?: string
  driver?: PostHogDriver
}

export class PostHogResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.POSTHOG
  readonly isRemote: boolean = true
  readonly indexTtl: number = 60
  readonly prompt: string
  readonly config: PostHogConfigResolved
  readonly driver: PostHogDriver
  readonly accessor: PostHogAccessor

  constructor(options: PostHogResourceOptions | PostHogConfig = {}) {
    super()
    const opts: PostHogResourceOptions =
      'config' in options || 'driver' in options || 'prefix' in options
        ? options
        : { config: options as PostHogConfig }
    this.config = resolvePostHogConfig(opts.config ?? {})
    this.driver =
      opts.driver ??
      new HttpPostHogDriver({ baseUrl: this.config.baseUrl, apiKey: this.config.apiKey })
    this.accessor = new PostHogAccessor(this.driver, this.config)
    this.prompt = POSTHOG_PROMPT.replace('{prefix}', opts.prefix ?? '')
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  ops(): readonly RegisteredOp[] {
    return POSTHOG_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return POSTHOG_COMMANDS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return posthogRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return posthogReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return posthogStat(this.accessor, p, this.index)
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
    return resolvePostHogGlob(this.accessor, effective, this.index)
  }
}
