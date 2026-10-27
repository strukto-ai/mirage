import { z } from 'zod'

export const RuntimeChoice = z.object({ runtime: z.enum(['monty', 'local']), reason: z.string() })
