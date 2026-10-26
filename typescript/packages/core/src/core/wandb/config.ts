import { z } from 'zod'
import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  secretStr,
  type ConfigOf,
  type RedactedConfig,
} from '../../vfs/secrets.ts'
import { timeoutShape } from '../api/config.ts'

export const WandbConfigSchema = z
  .object({
    ...timeoutShape,
    entities: z
      .array(
        z
          .string()
          .min(1)
          .regex(/^[^/\\\0]+$/)
          .refine((value) => !['.', '..'].includes(value)),
      )
      .min(1)
      .describe(
        'W&B entities (users or teams) the mount shows as top-level directories; no other entity is reachable.',
      ),
    apiKey: secretStr()
      .default('')
      .describe('W&B API key, sent as HTTP Basic auth. Empty sends no credentials.'),
    baseUrl: z
      .string()
      .default('https://api.wandb.ai')
      .describe(
        'W&B API root. Queries go to its `/graphql`, and only downloads from the same origin carry the key.',
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(100)
      .describe('Items per GraphQL page, and steps per window when reading `history.jsonl`.'),
    maxPages: z
      .number()
      .int()
      .min(1)
      .default(10000)
      .describe(
        'The most pages one listing or history read fetches. Past it the read fails rather than return a partial result.',
      ),
  })
  .strict()
export type WandbConfig = ConfigOf<typeof WandbConfigSchema>
export type WandbConfigRedacted = RedactedConfig<WandbConfig, 'apiKey'>
export function normalizeWandbConfig(input: Record<string, unknown>): WandbConfig {
  return parseConfigWithSchema(WandbConfigSchema, input)
}
export function redactWandbConfig(config: WandbConfig): WandbConfigRedacted {
  return redactConfigWithSchema(WandbConfigSchema, config) as WandbConfigRedacted
}
