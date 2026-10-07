import { VFSName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'

export const ONEDRIVE_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands(VFSName.ONEDRIVE),
]
