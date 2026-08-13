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

import {
  type ConfigOf,
  normalizeFields,
  redactConfigWithSchema,
  type RedactedConfig,
  secretStr,
  z,
} from '@struktoai/mirage-core'

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// Doubles as the himalaya CLI's configModel: parse applies the same
// defaults buildEmailConfig fills in, and secretStr marks the password
// for snapshot redaction.
export const EmailConfigSchema = z.object({
  imapHost: z.string(),
  imapPort: z.number().default(993),
  smtpHost: z.string(),
  smtpPort: z.number().default(587),
  username: z.string(),
  password: secretStr(),
  useSsl: z.boolean().default(true),
  maxMessages: z.number().default(200),
  /**
   * Upstream himalaya's message.send.save-copy, whose default is true
   * since pimalaya/himalaya#536.
   */
  saveCopy: z.boolean().default(true),
  /** Its folder.alias.sent: null means ask the server for its \Sent mailbox. */
  sentFolder: z.string().nullable().default(null),
})

export type EmailConfig = ConfigOf<typeof EmailConfigSchema>

export type EmailConfigRedacted = RedactedConfig<EmailConfig, 'password'>

export function redactEmailConfig(config: EmailConfig): EmailConfigRedacted {
  return redactConfigWithSchema(EmailConfigSchema, config) as unknown as EmailConfigRedacted
}

// What a caller writes, which is the schema before its defaults land.
export type EmailConfigInput = z.input<typeof EmailConfigSchema>

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
    saveCopy: input.saveCopy ?? true,
    sentFolder: input.sentFolder ?? null,
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
      save_copy: 'saveCopy',
      sent_folder: 'sentFolder',
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
  if (typeof norm.saveCopy === 'boolean') built.saveCopy = norm.saveCopy
  if (typeof norm.sentFolder === 'string') built.sentFolder = norm.sentFolder
  return buildEmailConfig(built)
}
