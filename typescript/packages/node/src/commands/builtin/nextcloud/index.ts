import { makeGenericCommands } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { VFSName } from '@struktoai/mirage-core/types'
import type { NextcloudAccessor } from '../../../accessor/nextcloud.ts'
import { NEXTCLOUD_IO } from './io.ts'

export const NEXTCLOUD_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<NextcloudAccessor>(VFSName.NEXTCLOUD, NEXTCLOUD_IO),
]
