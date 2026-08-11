import { makeGenericCommands, ResourceName, type RegisteredCommand } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../../accessor/nextcloud.ts'
import { NEXTCLOUD_IO } from './io.ts'

export const NEXTCLOUD_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<NextcloudAccessor>(ResourceName.NEXTCLOUD, NEXTCLOUD_IO),
]
