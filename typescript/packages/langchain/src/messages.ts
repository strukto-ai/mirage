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

interface MessageLike {
  content?: unknown
}

interface ContentBlock {
  type?: string
  text?: string
}

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  if (typeof value !== 'object' || value === null) return false
  const block = value as ContentBlock
  return block.type === 'text' && typeof block.text === 'string'
}

export function extractText(messages: readonly MessageLike[]): string[] {
  const texts: string[] = []
  for (const msg of messages) {
    if (!('content' in msg) || msg.content === undefined || msg.content === null) continue
    const content = msg.content
    if (typeof content === 'string') {
      if (content.trim().length > 0) texts.push(content)
      continue
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isTextBlock(block) && block.text.trim().length > 0) {
          texts.push(block.text)
        }
      }
    }
  }
  return texts
}
