import { VFSName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'

export const SHAREPOINT_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands(VFSName.SHAREPOINT),
]
