import {
  type ConfigOf,
  parseConfigWithSchema,
  redactConfigWithSchema,
  type RedactedConfig,
  secretStr,
  z,
} from '@struktoai/mirage-core/resource/secrets'

const NextcloudConfigSchema = z.object({
  url: z
    .string({ error: 'nextcloud config requires a non-empty url' })
    .min(1, 'nextcloud config requires a non-empty url'),
  username: z.string().optional(),
  password: secretStr().optional(),
  verifySsl: z.boolean().optional(),
  timeout: z.number().optional(),
})

export type NextcloudConfig = ConfigOf<typeof NextcloudConfigSchema>

export type NextcloudConfigRedacted = RedactedConfig<NextcloudConfig, 'password'>

export function normalizeNextcloudConfig(config: Record<string, unknown>): NextcloudConfig {
  return parseConfigWithSchema(NextcloudConfigSchema, config)
}

export function redactNextcloudConfig(config: NextcloudConfig): NextcloudConfigRedacted {
  return redactConfigWithSchema(NextcloudConfigSchema, config) as unknown as NextcloudConfigRedacted
}
