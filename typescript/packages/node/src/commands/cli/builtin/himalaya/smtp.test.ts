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

import { describe, expect, it } from 'vitest'
import { bccAddresses, stripBcc } from './smtp.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function message(...headerLines: string[]): Uint8Array {
  return ENC.encode(`${headerLines.join('\r\n')}\r\n\r\nthe body\r\n`)
}

// nodemailer's sendMail({raw}) does not read an envelope out of the
// message, so the recipients have to be lifted out by hand, and Bcc has
// to leave the bytes the way an MTA would drop it.
describe('bccAddresses', () => {
  it('finds a bare address', () => {
    expect(bccAddresses(message('To: a@x', 'Bcc: b@x'))).toEqual(['b@x'])
  })

  it('finds several, comma separated', () => {
    expect(bccAddresses(message('Bcc: b@x, c@x'))).toEqual(['b@x', 'c@x'])
  })

  it('unwraps an angle-bracketed display name', () => {
    expect(bccAddresses(message('Bcc: Bob <b@x>, c@x'))).toEqual(['b@x', 'c@x'])
  })

  it('follows a folded header onto its continuation line', () => {
    expect(bccAddresses(message('Bcc: b@x,', ' c@x'))).toEqual(['b@x', 'c@x'])
  })

  it('matches the header case-insensitively', () => {
    expect(bccAddresses(message('BCC: b@x'))).toEqual(['b@x'])
  })

  it('is empty when there is no Bcc', () => {
    expect(bccAddresses(message('To: a@x', 'Subject: hi'))).toEqual([])
  })

  it('does not mistake a body line for a header', () => {
    const raw = ENC.encode('To: a@x\r\n\r\nBcc: notaheader@x\r\n')
    expect(bccAddresses(raw)).toEqual([])
  })
})

describe('stripBcc', () => {
  it('removes the header while keeping the others and the body', () => {
    const out = DEC.decode(stripBcc(message('To: a@x', 'Bcc: b@x', 'Subject: hi')))
    expect(out).toBe('To: a@x\r\nSubject: hi\r\n\r\nthe body\r\n')
  })

  it('removes a folded header entirely, continuation lines included', () => {
    const out = DEC.decode(stripBcc(message('To: a@x', 'Bcc: b@x,', ' c@x', 'Subject: hi')))
    expect(out).toBe('To: a@x\r\nSubject: hi\r\n\r\nthe body\r\n')
  })

  it('keeps continuation lines that belong to a header it is keeping', () => {
    const out = DEC.decode(stripBcc(message('To: a@x,', ' d@x', 'Bcc: b@x')))
    expect(out).toBe('To: a@x,\r\n d@x\r\n\r\nthe body\r\n')
  })

  it('leaves a message with no Bcc untouched', () => {
    const raw = message('To: a@x', 'Subject: hi')
    expect(DEC.decode(stripBcc(raw))).toBe(DEC.decode(raw))
  })

  it('leaves a headers-only message untouched', () => {
    const raw = ENC.encode('To: a@x')
    expect(DEC.decode(stripBcc(raw))).toBe('To: a@x')
  })
})
