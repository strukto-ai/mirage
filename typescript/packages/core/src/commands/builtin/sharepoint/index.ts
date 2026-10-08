import { VFSName } from '../../../types.ts'
import type { Command } from '../../config.ts'
import { genericCommands } from '../generic_bind/index.ts'

export const SHAREPOINT_COMMANDS: readonly Command[] = [...genericCommands(VFSName.SHAREPOINT)]
