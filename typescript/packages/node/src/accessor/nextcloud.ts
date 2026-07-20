import type { Operator } from 'opendal'
import { Accessor, ResourceName } from '@struktoai/mirage-core'
import { loadOptionalPeer } from '../optional_peer.ts'
import type { NextcloudConfig } from '../resource/nextcloud/config.ts'

export class NextcloudAccessor extends Accessor {
  readonly resourceName = ResourceName.NEXTCLOUD
  private operatorPromise: Promise<Operator> | null = null

  constructor(readonly config: NextcloudConfig) {
    super()
  }

  operator(): Promise<Operator> {
    this.operatorPromise ??= this.createOperator()
    return this.operatorPromise
  }

  private async createOperator(): Promise<Operator> {
    const mod = await loadOptionalPeer(
      () => import('opendal') as Promise<{ Operator: typeof Operator }>,
      { feature: 'Nextcloud resources', packageName: 'opendal' },
    )
    const options: Record<string, string> = { endpoint: this.config.url }
    if (this.config.username !== undefined) options.username = this.config.username
    if (this.config.password !== undefined) options.password = this.config.password
    return new mod.Operator('webdav', options)
  }
}
