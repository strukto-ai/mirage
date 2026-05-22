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
  PathSpec,
  ResourceName,
  type FileStat,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { EmailAccessor } from '../../accessor/email.ts'
import { EMAIL_COMMANDS } from '../../commands/builtin/email/index.ts'
import { resolveGlob } from '../../core/email/glob.ts'
import { read as emailRead } from '../../core/email/read.ts'
import { readdir as emailReaddir } from '../../core/email/readdir.ts'
import { stat as emailStat } from '../../core/email/stat.ts'
import { EMAIL_OPS } from '../../ops/email/index.ts'
import { redactEmailConfig, type EmailConfig, type EmailConfigRedacted } from './config.ts'
import { EMAIL_PROMPT } from './prompt.ts'

export interface EmailResourceState {
  type: string
  config: EmailConfigRedacted
}

export class EmailResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.EMAIL
  readonly isRemote: boolean = true
  readonly indexTtl: number = 86_400
  readonly prompt: string = EMAIL_PROMPT
  readonly config: EmailConfig
  readonly accessor: EmailAccessor

  constructor(config: EmailConfig) {
    super()
    this.config = config
    this.accessor = new EmailAccessor(config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  async close(): Promise<void> {
    await this.accessor.close()
  }

  commands(): readonly RegisteredCommand[] {
    return EMAIL_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return EMAIL_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return emailRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return emailReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return emailStat(this.accessor, p, this.index)
  }

  async fingerprint(p: PathSpec): Promise<string | null> {
    const lookup = await this.index.get(p.original)
    return lookup.entry?.remoteTime ?? null
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
    return resolveGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<EmailResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactEmailConfig(this.config),
    })
  }

  loadState(_state: EmailResourceState): Promise<void> {
    return Promise.resolve()
  }
}
