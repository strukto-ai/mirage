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

import { JaegerAccessor } from '../../accessor/jaeger.ts'
import { HttpJaegerTransport } from '../../core/jaeger/client.ts'
import { VFSName } from '../../types.ts'
import { JaegerConfig } from '../jaeger/config.ts'
import { JaegerVFS as CoreJaegerVFS, VFS_MD } from '../jaeger/jaeger.ts'
import type { RedactedSchema } from '../secrets.ts'
import type { ConfigState } from '../types.ts'

export class JaegerVFS extends CoreJaegerVFS {
  override readonly name: string = VFSName.JAEGER
  override readonly cachesReads: boolean = true
  // Every listed file carries an exact size: a trace is rendered at readdir
  // from the search payload the listing already fetched, and operations.json
  // is sized by one call per service directory the caller opens.
  override readonly sizesAlwaysKnown: boolean = true
  override vfsMd: string = VFS_MD
  readonly config: JaegerConfig
  override readonly accessor: JaegerAccessor

  constructor(config: JaegerConfig) {
    super()
    this.config = config
    const transportOpts: { host?: string; timeout?: number } = {}
    if (config.host !== undefined) transportOpts.host = config.host
    if (config.timeout !== undefined) transportOpts.timeout = config.timeout
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

  override getState(): Promise<ConfigState<RedactedSchema<typeof JaegerConfig>>> {
    return Promise.resolve(this.configState(JaegerConfig, this.config))
  }
}
