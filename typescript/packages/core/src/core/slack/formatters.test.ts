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
import {
  buildQuery,
  channelDirname,
  dmDirname,
  fileBlobName,
  formatFileGrepResults,
  formatGrepResults,
  userFilename,
} from './formatters.ts'
import type { SlackScope } from './scope.ts'

const ENC = new TextEncoder()

describe('buildQuery', () => {
  it('returns pattern unchanged when no container', () => {
    const scope: SlackScope = { useNative: true, resourcePath: '/' }
    expect(buildQuery('hi', scope)).toBe('hi')
  })

  it('prefixes channels with in:#name', () => {
    const scope: SlackScope = {
      useNative: true,
      container: 'channels',
      channelName: 'general',
      resourcePath: 'channels/general__C1',
    }
    expect(buildQuery('hi', scope)).toBe('in:#general hi')
  })

  it('prefixes dms with in:@name', () => {
    const scope: SlackScope = {
      useNative: true,
      container: 'dms',
      channelName: 'alice',
      resourcePath: 'dms/alice__D1',
    }
    expect(buildQuery('hi', scope)).toBe('in:@alice hi')
  })
})

describe('formatGrepResults', () => {
  it('formats matches with channel/date prefix', () => {
    const raw = ENC.encode(
      JSON.stringify({
        messages: {
          matches: [
            {
              channel: { name: 'general', id: 'C1' },
              ts: '1700000000.000100',
              user: 'U1',
              text: 'hello world',
            },
          ],
        },
      }),
    )
    const scope: SlackScope = {
      useNative: true,
      container: 'channels',
      channelName: 'general',
      channelId: 'C1',
      resourcePath: 'channels/general__C1',
    }
    const lines = formatGrepResults(raw, scope, '/mnt/slack')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^\/mnt\/slack\/channels\/general__C1\/\d{4}-\d{2}-\d{2}\/chat\.jsonl:\[U1\] hello world$/,
    )
  })

  it('falls back to scope channel info when not present in match', () => {
    const raw = ENC.encode(
      JSON.stringify({
        messages: { matches: [{ ts: '1700000000.0', text: 'hi', username: 'alice' }] },
      }),
    )
    const scope: SlackScope = {
      useNative: true,
      container: 'channels',
      channelName: 'general',
      channelId: 'C1',
      resourcePath: 'channels/general__C1',
    }
    const lines = formatGrepResults(raw, scope, '/mnt/slack')
    expect(lines[0]).toContain('/channels/general__C1/')
    expect(lines[0]).toContain('[alice] hi')
  })

  it('returns empty when no matches', () => {
    const raw = ENC.encode(JSON.stringify({ messages: { matches: [] } }))
    const scope: SlackScope = { useNative: true, resourcePath: '/' }
    expect(formatGrepResults(raw, scope, '/mnt/slack')).toEqual([])
  })

  it('replaces newlines in text with spaces', () => {
    const raw = ENC.encode(
      JSON.stringify({
        messages: {
          matches: [{ ts: '1.0', user: 'U1', text: 'a\nb\nc' }],
        },
      }),
    )
    const scope: SlackScope = {
      useNative: true,
      container: 'channels',
      channelName: 'general',
      channelId: 'C1',
      resourcePath: 'channels/general__C1',
    }
    const lines = formatGrepResults(raw, scope, '/mnt/slack')
    expect(lines[0]).toContain('[U1] a b c')
  })
})

describe('fileBlobName', () => {
  it('builds <stem>__<id>.<ext> when name has extension', () => {
    expect(fileBlobName({ id: 'F1', name: 'report.pdf' })).toBe('report__F1.pdf')
  })

  it('falls back to title when name missing', () => {
    expect(fileBlobName({ id: 'F2', title: 'design doc.docx' })).toBe('design_doc__F2.docx')
  })

  it('drops extension when name has none', () => {
    expect(fileBlobName({ id: 'F3', name: 'readme' })).toBe('readme__F3')
  })

  it("uses 'file' fallback when no name/title", () => {
    expect(fileBlobName({ id: 'F4' })).toBe('file__F4')
  })
})

describe('formatFileGrepResults', () => {
  it('emits one line per file match with full path', () => {
    const raw = ENC.encode(
      JSON.stringify({
        files: {
          matches: [
            { id: 'F1', name: 'design.pdf', timestamp: 1700000000 },
            { id: 'F2', title: 'spec.md', timestamp: '1700000500' },
          ],
        },
      }),
    )
    const scope: SlackScope = {
      useNative: true,
      container: 'channels',
      channelName: 'general',
      channelId: 'C1',
      resourcePath: 'channels/general__C1',
    }
    const lines = formatFileGrepResults(raw, scope, '/mnt/slack')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(
      /^\/mnt\/slack\/channels\/general__C1\/\d{4}-\d{2}-\d{2}\/files\/design__F1\.pdf:\[file\] design\.pdf$/,
    )
    expect(lines[1]).toContain('files/spec__F2.md:[file] spec.md')
  })

  it('skips matches when scope has no channelId', () => {
    const raw = ENC.encode(
      JSON.stringify({
        files: { matches: [{ id: 'F1', name: 'x.txt', timestamp: 1 }] },
      }),
    )
    const scope: SlackScope = { useNative: true, resourcePath: '/' }
    expect(formatFileGrepResults(raw, scope, '/mnt/slack')).toEqual([])
  })
})

describe('dirname helpers re-exported', () => {
  it('channelDirname', () => {
    expect(channelDirname({ id: 'C1', name: 'general' })).toBe('general__C1')
  })

  it('dmDirname uses user_map', () => {
    expect(dmDirname({ id: 'D1', user: 'U1' }, { U1: 'alice' })).toBe('alice__D1')
  })

  it('userFilename ends in .json', () => {
    expect(userFilename({ id: 'U1', name: 'alice' })).toBe('alice__U1.json')
  })
})
