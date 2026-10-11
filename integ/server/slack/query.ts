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

// Slack search-query DSL (a faithful subset). Unquoted operator tokens are
// stripped and interpreted; a "quoted phrase" is kept verbatim as literal:
//   in:#channel   scope to a channel by name (also in:##channel)
//   in:@user      scope to a DM by the other member's name
//   from:@user    only messages authored by that user (name resolved to id)
//   from:<@U…>    only messages authored by that user ID
//   after:DATE    strictly after that UTC day (DATE = YYYY-MM-DD)
//   before:DATE   strictly before that UTC day
//   on:DATE       within that UTC day
//   has::name:    only messages carrying that reaction
// Everything else is the literal, matched as an ASCII-case-insensitive
// substring against the stored text/name/title/content -- data-driven, so the
// same fake answers any query, not just the fixture's exact wording. Names
// (#channel / @user) are resolved to ids server-side, like real Slack.
export interface ParsedQuery {
  literal: string
  channelName?: string
  dmName?: string
  fromName?: string
  fromId?: string
  after?: string
  before?: string
  on?: string
  reaction?: string
}

const TOKEN_RE = /"([^"]*)"|(\S+)/g

const PREFIXES: [string, keyof ParsedQuery][] = [
  ['in:#', 'channelName'],
  ['in:@', 'dmName'],
  ['in:', 'channelName'],
  ['from:@', 'fromName'],
  ['from:', 'fromName'],
  ['after:', 'after'],
  ['before:', 'before'],
  ['on:', 'on'],
  ['during:', 'on'],
]

function tokenize(query: string): { value: string; quoted: boolean }[] {
  const tokens: { value: string; quoted: boolean }[] = []
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(query)) !== null) {
    if (m[1] !== undefined) tokens.push({ value: m[1], quoted: true })
    else if (m[2] !== undefined) tokens.push({ value: m[2], quoted: false })
  }
  return tokens
}

export function parseQuery(query: string): ParsedQuery {
  const terms: string[] = []
  const out: ParsedQuery = { literal: '' }
  for (const { value, quoted } of tokenize(query)) {
    const mention = quoted ? null : /^from:<@([A-Z0-9]+)>$/.exec(value)
    if (mention !== null) {
      delete out.fromName
      out.fromId = mention[1]!
      continue
    }
    const reaction = quoted ? null : /^has::([^:\s]+):$/.exec(value)
    if (reaction !== null) {
      out.reaction = reaction[1]!
      continue
    }
    // Order matters: `from:@x` must be tried before `from:x`, which is why
    // PREFIXES is a list rather than a map.
    const hit = quoted ? undefined : PREFIXES.find(([p]) => value.startsWith(p))
    if (hit !== undefined) {
      const [prefix, key] = hit
      out[key] = value.slice(prefix.length)
      if (key === 'channelName') out.channelName = out.channelName!.replace(/^#+/, '')
      if (key === 'fromName') delete out.fromId
      continue
    }
    terms.push(value)
  }
  out.literal = terms.join(' ')
  return out
}

function dayStartEpoch(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000)
}

export function withinDates(tsNum: number, parsed: ParsedQuery): boolean {
  if (parsed.after !== undefined && tsNum < dayStartEpoch(parsed.after) + 86400) return false
  if (parsed.before !== undefined && tsNum >= dayStartEpoch(parsed.before)) return false
  if (parsed.on !== undefined) {
    const start = dayStartEpoch(parsed.on)
    if (tsNum < start || tsNum >= start + 86400) return false
  }
  return true
}
