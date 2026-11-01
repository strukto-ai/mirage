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

import type { JsonObject } from '../../types.ts'
import { asArray, asObject, stringOf as strOf } from '../../utils/records.ts'

function richTextToMd(richTextList: unknown[]): string {
  const parts: string[] = []
  for (const item of richTextList) {
    const rt = asObject(item)
    let text = strOf(rt, 'plain_text')
    const annotations = asObject(rt.annotations)
    if (annotations.code === true) text = `\`${text}\``
    if (annotations.bold === true) text = `**${text}**`
    if (annotations.italic === true) text = `*${text}*`
    if (annotations.strikethrough === true) text = `~~${text}~~`
    const href = rt.href
    if (typeof href === 'string' && href !== '') text = `[${text}](${href})`
    parts.push(text)
  }
  return parts.join('')
}

function blockToMd(block: JsonObject, indent: number): string {
  const btype = strOf(block, 'type')
  const content = asObject(block[btype])
  const text = richTextToMd(asArray(content.rich_text))
  const prefix = '  '.repeat(indent)

  if (btype === 'paragraph') return `${prefix}${text}`
  if (btype === 'heading_1' || btype === 'heading_2' || btype === 'heading_3') {
    const level = Number.parseInt(btype.slice(-1), 10)
    return `${'#'.repeat(level)} ${text}`
  }
  if (btype === 'bulleted_list_item') return `${prefix}- ${text}`
  if (btype === 'numbered_list_item') return `${prefix}1. ${text}`
  if (btype === 'to_do') {
    const marker = content.checked === true ? 'x' : ' '
    return `${prefix}- [${marker}] ${text}`
  }
  if (btype === 'toggle') return `${prefix}<details><summary>${text}</summary></details>`
  if (btype === 'code') {
    const language = strOf(content, 'language')
    return `\`\`\`${language}\n${text}\n\`\`\``
  }
  if (btype === 'quote') return `${prefix}> ${text}`
  if (btype === 'callout') {
    const icon = asObject(content.icon)
    const emoji = strOf(icon, 'type') === 'emoji' ? strOf(icon, 'emoji') : ''
    return `${prefix}> ${emoji} ${text}`
  }
  if (btype === 'divider') return '---'
  if (btype === 'image') {
    const img = asObject(content[strOf(content, 'type')])
    const url = strOf(img, 'url')
    const caption = richTextToMd(asArray(content.caption))
    return `![${caption}](${url})`
  }
  if (btype === 'bookmark') {
    const url = strOf(content, 'url')
    const caption = richTextToMd(asArray(content.caption))
    return `[${caption || url}](${url})`
  }
  if (btype === 'equation') return `$$${strOf(content, 'expression')}$$`
  if (btype === 'table_of_contents') return '[TOC]'
  if (btype === 'child_page' || btype === 'child_database') return ''
  return text !== '' ? `${prefix}${text}` : ''
}

function walkBlock(block: JsonObject, indent: number, lines: string[]): void {
  const line = blockToMd(block, indent)
  if (line !== '' || strOf(block, 'type') === 'paragraph') lines.push(line)
  for (const child of asArray(block.children)) {
    walkBlock(asObject(child), indent + 1, lines)
  }
}

export function blocksToMarkdown(blocks: readonly JsonObject[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    walkBlock(block, 0, lines)
  }
  return lines.length > 0 ? lines.join('\n\n') + '\n' : ''
}
