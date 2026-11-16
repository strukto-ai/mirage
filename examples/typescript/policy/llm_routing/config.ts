import { z } from 'zod'

export const MachineChoice = z.object({ machine: z.enum(['monty', 'local']), reason: z.string() })
