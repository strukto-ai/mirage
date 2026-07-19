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
import { GMAIL_PROMPT, GMAIL_WRITE_PROMPT } from './prompt.ts'

describe('GMAIL_PROMPT', () => {
  it('renders prefix and includes path anatomy + processed shape', () => {
    const rendered = GMAIL_PROMPT.replace(/\{prefix\}/g, '/gmail')
    expect(rendered).toContain('<label>')
    expect(rendered).toContain('INBOX')
    expect(rendered).toContain('after:/before:')
    expect(rendered).toContain('mirage-processed')
    expect(rendered).toContain('.body_text')
    expect(rendered).toContain('gws gmail +read')
    expect(rendered).toContain('gws gmail +triage')
  })

  it('documents file-per-message layout with sibling attachments dir', () => {
    const rendered = GMAIL_PROMPT.replace(/\{prefix\}/g, '/gmail')
    expect(rendered).toContain('<subject>__<message-id>.gmail.json')
    expect(rendered).toContain('<subject>__<message-id>/')
    expect(rendered).toContain('attachments dir')
    expect(rendered).toContain('.attachments[]')
  })

  it('mentions grep skips binary attachments', () => {
    const rendered = GMAIL_PROMPT.replace(/\{prefix\}/g, '/gmail')
    expect(rendered).toContain('grep')
    expect(rendered.toLowerCase()).toContain('binary')
  })
})

describe('GMAIL_WRITE_PROMPT', () => {
  it('matches actual command flag signatures', () => {
    expect(GMAIL_WRITE_PROMPT).toContain('gws gmail +send')
    expect(GMAIL_WRITE_PROMPT).toContain('--to')
    expect(GMAIL_WRITE_PROMPT).toContain('--subject')
    expect(GMAIL_WRITE_PROMPT).toContain('--body')
    expect(GMAIL_WRITE_PROMPT).toContain('gws gmail +reply')
    expect(GMAIL_WRITE_PROMPT).toContain('gws gmail +reply-all')
    expect(GMAIL_WRITE_PROMPT).toContain('gws gmail +forward')
    expect(GMAIL_WRITE_PROMPT).toContain('--message-id')
  })

  it('documents rm (trash) and the newline gotcha', () => {
    expect(GMAIL_WRITE_PROMPT).toContain('rm ')
    expect(GMAIL_WRITE_PROMPT).toContain('.gmail.json')
    expect(GMAIL_WRITE_PROMPT).toContain('Trash')
    expect(GMAIL_WRITE_PROMPT).toContain("$'")
  })
})
