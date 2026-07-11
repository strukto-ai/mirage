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

import { loadOptionalPeer } from '@struktoai/mirage-core'
import type * as Nodemailer from 'nodemailer'
import type { EmailConfig } from '../../resource/email/config.ts'
import type { FetchedMessage } from './_client.ts'

const transporterCache = new WeakMap<EmailConfig, Nodemailer.Transporter>()

async function getTransporter(config: EmailConfig): Promise<Nodemailer.Transporter> {
  const existing = transporterCache.get(config)
  if (existing !== undefined) return existing
  const mod = await loadOptionalPeer(
    () => import('nodemailer') as unknown as Promise<typeof Nodemailer>,
    { feature: 'email send/reply/forward', packageName: 'nodemailer' },
  )
  const transporter = mod.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.username, pass: config.password },
  })
  transporterCache.set(config, transporter)
  return transporter
}

export interface SendResult {
  status: string
  to: string | string[]
  subject: string
}

export async function sendMessage(
  config: EmailConfig,
  to: string,
  subject: string,
  body: string,
): Promise<SendResult> {
  const t = await getTransporter(config)
  await t.sendMail({ from: config.username, to, subject, text: body })
  return { status: 'sent', to, subject }
}

export async function replyMessage(
  config: EmailConfig,
  original: FetchedMessage,
  body: string,
): Promise<SendResult> {
  const t = await getTransporter(config)
  const refs = [...original.references]
  if (original.message_id !== '') refs.push(original.message_id)
  const subject = `Re: ${original.subject}`
  await t.sendMail({
    from: config.username,
    to: original.from.email,
    subject,
    text: body,
    inReplyTo: original.message_id,
    references: refs,
  })
  return { status: 'sent', to: original.from.email, subject }
}

export async function replyAllMessage(
  config: EmailConfig,
  original: FetchedMessage,
  body: string,
): Promise<SendResult> {
  const t = await getTransporter(config)
  const all = new Set<string>()
  if (original.from.email !== '') all.add(original.from.email)
  for (const r of original.to) if (r.email !== '') all.add(r.email)
  for (const r of original.cc) if (r.email !== '') all.add(r.email)
  all.delete(config.username)
  const recipients = [...all].sort()
  const refs = [...original.references]
  if (original.message_id !== '') refs.push(original.message_id)
  const subject = `Re: ${original.subject}`
  await t.sendMail({
    from: config.username,
    to: recipients,
    subject,
    text: body,
    inReplyTo: original.message_id,
    references: refs,
  })
  return { status: 'sent', to: recipients, subject }
}

export async function forwardMessage(
  config: EmailConfig,
  original: FetchedMessage,
  to: string,
): Promise<SendResult> {
  const t = await getTransporter(config)
  const subject = `Fwd: ${original.subject}`
  const fwdBody =
    `---------- Forwarded message ----------\n` +
    `From: ${original.from.name} <${original.from.email}>\n` +
    `Date: ${original.date}\n` +
    `Subject: ${original.subject}\n\n` +
    original.body_text
  await t.sendMail({ from: config.username, to, subject, text: fwdBody })
  return { status: 'sent', to, subject }
}
