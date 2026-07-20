export interface NextcloudConfig {
  url: string
  username?: string
  password?: string
  verifySsl?: boolean
  timeout?: number
}

export interface NextcloudConfigRedacted extends Omit<NextcloudConfig, 'password'> {
  password?: '<REDACTED>'
}

export function normalizeNextcloudConfig(config: Record<string, unknown>): NextcloudConfig {
  const url = config.url
  if (typeof url !== 'string' || url === '') {
    throw new TypeError('nextcloud config requires a non-empty url')
  }
  const normalized: NextcloudConfig = { url }
  const username = config.username
  const password = config.password
  const verifySsl = config.verifySsl ?? config.verify_ssl
  const timeout = config.timeout
  if (typeof username === 'string' && username !== '') normalized.username = username
  if (typeof password === 'string' && password !== '') normalized.password = password
  if (typeof verifySsl === 'boolean') normalized.verifySsl = verifySsl
  if (typeof timeout === 'number') normalized.timeout = timeout
  return normalized
}

export function redactNextcloudConfig(config: NextcloudConfig): NextcloudConfigRedacted {
  const { password, ...visible } = config
  return {
    ...visible,
    ...(password !== undefined ? { password: '<REDACTED>' as const } : {}),
  }
}
