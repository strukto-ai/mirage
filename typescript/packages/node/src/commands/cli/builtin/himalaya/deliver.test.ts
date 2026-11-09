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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EmailAccessor } from '@struktoai/mirage-core/accessor/email'
import type { EmailConfig } from '@struktoai/mirage-core/core/email/config'
import {
  deliver,
  resolveSentFolder,
  saveSentCopy,
} from '@struktoai/mirage-core/commands/cli/builtin/himalaya/deliver'

const sendRawMock = vi.hoisted(() => vi.fn())

vi.mock('@struktoai/mirage-core/commands/cli/builtin/himalaya/smtp', () => ({
  sendRaw: sendRawMock,
}))

const RAW = new TextEncoder().encode('From: me@x\r\nTo: a@b.com\r\nSubject: Hi\r\n\r\nyo')

const GMAIL = [
  { pathAsListed: 'INBOX', flags: new Set<string>() },
  { pathAsListed: '[Gmail]/Sent Mail', flags: new Set(['\\Sent']) },
  { pathAsListed: '[Gmail]/Trash', flags: new Set(['\\Trash']) },
]
const PLAIN = [
  { pathAsListed: 'INBOX', flags: new Set<string>() },
  { pathAsListed: 'Archive', flags: new Set<string>() },
]

const listMock = vi.fn()
const appendMock = vi.fn()
let closeSpy: ReturnType<typeof vi.spyOn>

function config(overrides: Partial<EmailConfig> = {}): EmailConfig {
  return {
    imapHost: 'h',
    imapPort: 993,
    smtpHost: 'h',
    smtpPort: 587,
    username: 'u',
    password: 'p',
    useSsl: false,
    maxMessages: 200,
    saveCopy: true,
    sentFolder: null,
    trashFolder: null,
    ...overrides,
  }
}

function account(overrides: Partial<EmailConfig> = {}): EmailAccessor {
  return new EmailAccessor(config(overrides))
}

beforeEach(() => {
  vi.clearAllMocks()
  listMock.mockResolvedValue(PLAIN)
  appendMock.mockResolvedValue({ destination: 'Sent' })
  sendRawMock.mockResolvedValue({ to: [{ name: '', email: 'a@b.com' }], subject: 'Hi' })
  vi.spyOn(EmailAccessor.prototype, 'getImap').mockResolvedValue({
    list: listMock,
    append: appendMock,
  } as unknown as Awaited<ReturnType<EmailAccessor['getImap']>>)
  closeSpy = vi.spyOn(EmailAccessor.prototype, 'close').mockResolvedValue()
})

describe('resolveSentFolder', () => {
  it('takes the mailbox the server tags \\Sent', async () => {
    listMock.mockResolvedValue(GMAIL)
    expect(await resolveSentFolder(account(), null)).toBe('[Gmail]/Sent Mail')
  })

  it('falls back to Sent when the server tags nothing', async () => {
    expect(await resolveSentFolder(account(), null)).toBe('Sent')
  })

  it('lets a configured folder win, without asking the server', async () => {
    listMock.mockResolvedValue(GMAIL)
    expect(await resolveSentFolder(account(), 'Archive')).toBe('Archive')
    expect(listMock).not.toHaveBeenCalled()
  })
})

describe('saveSentCopy', () => {
  it('appends the message seen, and leaves the accessor open', async () => {
    listMock.mockResolvedValue(GMAIL)
    expect(await saveSentCopy(account(), RAW)).toBe('[Gmail]/Sent Mail')
    expect(appendMock).toHaveBeenCalledWith('[Gmail]/Sent Mail', Buffer.from(RAW), ['\\Seen'])
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it('names the mailbox when the server refuses', async () => {
    appendMock.mockResolvedValue(false)
    await expect(saveSentCopy(account(), RAW)).rejects.toThrow('Sent: the server refused')
    expect(closeSpy).not.toHaveBeenCalled()
  })
})

describe('deliver', () => {
  it('sends, then saves', async () => {
    await expect(deliver(account(), RAW)).resolves.toBe(true)
    expect(sendRawMock).toHaveBeenCalledWith(expect.anything(), RAW)
    expect(appendMock).toHaveBeenCalledOnce()
  })

  it('sends and touches no mailbox when saveCopy is off', async () => {
    await expect(deliver(account({ saveCopy: false }), RAW)).resolves.toBe(false)
    expect(sendRawMock).toHaveBeenCalledOnce()
    expect(appendMock).not.toHaveBeenCalled()
  })

  it('fails the command when the copy fails, saying the message left', async () => {
    appendMock.mockRejectedValue(new Error('Sent: over quota'))
    await expect(deliver(account(), RAW)).rejects.toMatchObject({
      message: 'Message sent, but saving a copy to Sent failed',
      sources: ['Sent: over quota'],
    })
    expect(sendRawMock).toHaveBeenCalledOnce()
  })

  it('files into the mailbox --save names, over the account default', async () => {
    listMock.mockResolvedValue(GMAIL)
    await expect(deliver(account(), RAW, 'Drafts')).resolves.toBe(true)
    expect(appendMock).toHaveBeenCalledWith('Drafts', Buffer.from(RAW), ['\\Seen'])
    expect(listMock).not.toHaveBeenCalled()
  })

  it('honours --save even when saveCopy is off', async () => {
    await expect(deliver(account({ saveCopy: false }), RAW, 'Drafts')).resolves.toBe(true)
    expect(appendMock).toHaveBeenCalledOnce()
  })

  it('honours --no-save over the account default', async () => {
    await expect(deliver(account(), RAW, null, true)).resolves.toBe(false)
    expect(appendMock).not.toHaveBeenCalled()
  })
})
