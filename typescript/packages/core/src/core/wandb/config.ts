import { z } from 'zod'
import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  secretStr,
  type ConfigOf,
  type RedactedConfig,
} from '../../vfs/secrets.ts'

export const WandbConfigSchema = z
  .object({
    entities: z
      .array(
        z
          .string()
          .min(1)
          .regex(/^[^/\\\0]+$/)
          .refine((value) => !['.', '..'].includes(value)),
      )
      .min(1),
    apiKey: secretStr().default(''),
    baseUrl: z.string().default('https://api.wandb.ai'),
    pageSize: z.number().int().min(1).max(1000).default(100),
    maxPages: z.number().int().min(1).default(10000),
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
