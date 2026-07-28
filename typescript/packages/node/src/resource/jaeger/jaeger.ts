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
  HttpJaegerTransport,
  JAEGER_COMMANDS,
  JAEGER_OPS,
  JAEGER_PROMPT,
  JaegerAccessor,
  PathSpec,
  ResourceName,
  jaegerRead,
  jaegerReaddir,
  jaegerStat,
  mountKey,
  mountPrefixOf,
  makeResolveGlob,
  type FileStat,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { redactJaegerConfig, type JaegerConfig, type JaegerConfigRedacted } from './config.ts'
import { remoteSpec } from '@struktoai/mirage-core'

const resolveJaegerGlob = makeResolveGlob(jaegerReaddir)

export interface JaegerResourceState {
  type: string
  config: JaegerConfigRedacted
}

export class JaegerResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.JAEGER
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = JAEGER_PROMPT
  readonly config: JaegerConfig
  readonly accessor: JaegerAccessor

  constructor(config: JaegerConfig) {
    super()
    this.config = config
    const transportOpts: { host?: string; timeout?: number } = {}
    if (config.host !== undefined) transportOpts.host = config.host
    if (config.requestTimeout !== undefined) transportOpts.timeout = config.requestTimeout
    const accessorConfig: {
      defaultTraceLimit?: number
      defaultFromTimestamp?: string
      defaultToTimestamp?: string
    } = {}
    if (config.defaultTraceLimit !== undefined) {
      accessorConfig.defaultTraceLimit = config.defaultTraceLimit
    }
    if (config.defaultFromTimestamp !== undefined) {
      accessorConfig.defaultFromTimestamp = config.defaultFromTimestamp
    }
    if (config.defaultToTimestamp !== undefined) {
      accessorConfig.defaultToTimestamp = config.defaultToTimestamp
    }
    this.accessor = new JaegerAccessor(new HttpJaegerTransport(transportOpts), accessorConfig)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return JAEGER_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return JAEGER_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return jaegerRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return jaegerReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return jaegerStat(this.accessor, p, this.index)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            mountPrefixOf(p.virtual, p.resourcePath) !== ''
              ? p
              : new PathSpec({
                  virtual: p.virtual,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  resourcePath: mountKey(p.virtual, prefix),
                }),
          )
        : paths
    return resolveJaegerGlob(this.accessor, effective, this.index)
  }

  remoteMountSpec(): Record<string, unknown> {
    return remoteSpec('jaeger', this.config as unknown as Record<string, unknown>)
  }

  getState(): Promise<JaegerResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactJaegerConfig(this.config),
    })
  }

  loadState(_state: JaegerResourceState): Promise<void> {
    return Promise.resolve()
  }
}
