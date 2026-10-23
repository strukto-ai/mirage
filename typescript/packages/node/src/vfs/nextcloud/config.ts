import {
  type ConfigOf,
  parseConfigWithSchema,
  redactConfigWithSchema,
  type RedactedConfig,
  secretStr,
  z,
} from '@struktoai/mirage-core/vfs/secrets'

const NextcloudConfigSchema = z.object({
  url: z
    .string({ error: 'nextcloud config requires a non-empty url' })
    .min(1, 'nextcloud config requires a non-empty url')
    .describe(
      "WebDAV URL of the user's files, such as `https://cloud.example.com/remote.php/dav/files/alice/`.",
    ),
  username: z
    .string()
    .optional()
    .describe('Basic Auth user name; unset sends requests without credentials.'),
  password: secretStr()
    .optional()
    .describe(
      'Basic Auth password; use an app password (Settings → Security) rather than the account password.',
    ),
  verifySsl: z
    .boolean()
    .optional()
    .describe("Accepted but not applied: every request verifies the server's TLS certificate."),
  timeout: z.number().optional().meta({
    description:
      'Seconds one WebDAV request mirage sends itself (copy, checksum, quota, properties, search) may take; reads, writes and listings go through OpenDAL and its own timeouts.',
    default: 30,
  }),
  fullScanLimit: z
    .number()
    .int()
    .min(-1)
    .optional()
    .meta({
      description:
        'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit.',
      default: 1000,
    }),
})

export type NextcloudConfig = ConfigOf<typeof NextcloudConfigSchema>

export type NextcloudConfigRedacted = RedactedConfig<NextcloudConfig, 'password'>

export function normalizeNextcloudConfig(config: Record<string, unknown>): NextcloudConfig {
  return parseConfigWithSchema(NextcloudConfigSchema, config)
}

export function redactNextcloudConfig(config: NextcloudConfig): NextcloudConfigRedacted {
  return redactConfigWithSchema(NextcloudConfigSchema, config) as unknown as NextcloudConfigRedacted
}
