// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { normalizeFields, redactConfigWithSchema, secretStr, z } from '@struktoai/mirage-core'

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export interface EmailConfig {
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  username: string
  password: string
  useSsl: boolean
  maxMessages: number
}

export interface EmailConfigRedacted extends Omit<EmailConfig, 'password'> {
  password: '<REDACTED>'
}

export const EmailConfigSchema = z.object({
  imapHost: z.string(),
  imapPort: z.number(),
  smtpHost: z.string(),
  smtpPort: z.number(),
  username: z.string(),
  password: secretStr(),
  useSsl: z.boolean(),
  maxMessages: z.number(),
})

export function redactEmailConfig(config: EmailConfig): EmailConfigRedacted {
  return redactConfigWithSchema(EmailConfigSchema, config) as unknown as EmailConfigRedacted
}

export interface EmailConfigInput {
  imapHost: string
  imapPort?: number
  smtpHost: string
  smtpPort?: number
  username: string
  password: string
  useSsl?: boolean
  maxMessages?: number
}

export function buildEmailConfig(input: EmailConfigInput): EmailConfig {
  return {
    imapHost: input.imapHost,
    imapPort: input.imapPort ?? 993,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort ?? 587,
    username: input.username,
    password: input.password,
    useSsl: input.useSsl ?? true,
    maxMessages: input.maxMessages ?? 200,
  }
}

export function normalizeEmailConfig(input: Record<string, unknown>): EmailConfig {
  const norm = normalizeFields(input, {
    rename: {
      imap_host: 'imapHost',
      imap_port: 'imapPort',
      smtp_host: 'smtpHost',
      smtp_port: 'smtpPort',
      use_ssl: 'useSsl',
      max_messages: 'maxMessages',
    },
  })
  const built: EmailConfigInput = {
    imapHost: asString(norm.imapHost),
    smtpHost: asString(norm.smtpHost),
    username: asString(norm.username),
    password: asString(norm.password),
  }
  if (typeof norm.imapPort === 'number') built.imapPort = norm.imapPort
  if (typeof norm.smtpPort === 'number') built.smtpPort = norm.smtpPort
  if (typeof norm.useSsl === 'boolean') built.useSsl = norm.useSsl
  if (typeof norm.maxMessages === 'number') built.maxMessages = norm.maxMessages
  return buildEmailConfig(built)
}
