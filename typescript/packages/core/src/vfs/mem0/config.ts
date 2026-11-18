import { z } from 'zod'
import { defaultRequestTimeout } from '../../core/api/config.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { secretStr } from '../secrets.ts'

export const Mem0Config = z
  .object({
    timeout: defaultRequestTimeout,
    apiKey: secretStr().describe('Mem0 Platform API key.'),
    host: z
      .string()
      .default('https://api.mem0.ai')
      .transform(rstripSlash)
      .meta({ description: 'Mem0 API base URL.', default: 'https://api.mem0.ai' }),
    userId: z
      .string()
      .refine((value) => value.trim() !== '', 'Mem0 scope id cannot be empty')
      .nullable()
      .default(null)
      .describe("Mount this user's memories. Set exactly one of `userId`, `agentId` and `runId`."),
    agentId: z
      .string()
      .refine((value) => value.trim() !== '', 'Mem0 scope id cannot be empty')
      .nullable()
      .default(null)
      .describe("Mount this agent's memories. Set exactly one of `userId`, `agentId` and `runId`."),
    runId: z
      .string()
      .refine((value) => value.trim() !== '', 'Mem0 scope id cannot be empty')
      .nullable()
      .default(null)
      .describe("Mount this run's memories. Set exactly one of `userId`, `agentId` and `runId`."),
    defaultPageSize: z
      .number()
      .int()
      .positive('defaultPageSize must be positive')
      .default(100)
      .meta({
        description: 'Memories fetched per request while listing the scope.',
        default: 100,
      }),
    defaultSearchLimit: z
      .number()
      .int()
      .positive('defaultSearchLimit must be positive')
      .default(10)
      .meta({
        description: 'How many results `search` returns unless the line sets `top_k`.',
        default: 10,
      }),
  })
  .strict()
  .refine(
    ({ userId, agentId, runId }) =>
      [userId, agentId, runId].filter((value) => value !== null).length === 1,
    'Mem0Config requires exactly one of userId, agentId, runId',
  )

export type Mem0Config = z.input<typeof Mem0Config>
