import { SharePointAccessor, type SharePointConfig } from '../../accessor/sharepoint.ts'
import { SHAREPOINT_COMMANDS } from '../../commands/builtin/sharepoint/index.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { read, readdir, stat } from '../../core/sharepoint/index.ts'
import { SHAREPOINT_OPS } from '../../ops/sharepoint/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { ResourceName, type FileStat, type PathSpec } from '../../types.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { BaseResource, type Resource } from '../base.ts'
import { SHAREPOINT_PROMPT } from './prompt.ts'

const resolveGlob = makeResolveGlob(readdir)

export class SharePointResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.SHAREPOINT
  readonly cachesReads: boolean = true
  readonly supportsSnapshot: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = SHAREPOINT_PROMPT
  readonly accessor: SharePointAccessor

  constructor(config: SharePointConfig) {
    super()
    this.accessor = new SharePointAccessor(config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return SHAREPOINT_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return SHAREPOINT_OPS
  }

  glob(paths: readonly PathSpec[], _prefix = ''): Promise<PathSpec[]> {
    return resolveGlob(this.accessor, paths, this.index)
  }

  readFile(path: PathSpec): Promise<Uint8Array> {
    return read(this.accessor, path, this.index)
  }

  readdir(path: PathSpec): Promise<string[]> {
    return readdir(this.accessor, path, this.index)
  }

  stat(path: PathSpec): Promise<FileStat> {
    return stat(this.accessor, path, this.index)
  }

  getState(): Record<string, unknown> {
    const config = this.accessor.config
    return {
      type: this.kind,
      config: {
        accessToken: '<REDACTED>',
        tenantHost: config.tenantHost,
        timeout: config.timeout,
        maxRetries: config.maxRetries,
        siteFilter: config.siteFilter,
        site: config.site,
        drive: config.drive,
        keyPrefix: config.keyPrefix,
      },
    }
  }

  loadState(_state: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}
