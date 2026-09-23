import type { JsonValue, Reply } from '../kit/typescript/index.ts'
import type { BlockSpec, Json } from './types.ts'
import { apiError } from './wire.ts'

const HEADINGS = new Set(['heading_1', 'heading_2', 'heading_3'])
const CONTAINERS = new Set([
  'paragraph',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'synced_block',
  'column',
  'column_list',
  'table',
  'template',
  'child_page',
  'child_database',
])
export const BLOCK_TYPES = new Set([
  ...HEADINGS,
  ...CONTAINERS,
  'audio',
  'bookmark',
  'breadcrumb',
  'code',
  'divider',
  'embed',
  'equation',
  'file',
  'image',
  'link_preview',
  'link_to_page',
  'pdf',
  'table_of_contents',
  'table_row',
  'video',
])

function isObject(value: JsonValue | undefined): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validation(message: string): Reply {
  // Status and envelope follow the documented API; wording is not live-probed.
  return apiError(400, 'validation_error', message)
}

export function supportsChildren(type: string, payload: Json): boolean {
  if (HEADINGS.has(type)) return payload.is_toggleable === true
  if (type === 'synced_block') return payload.synced_from == null
  return CONTAINERS.has(type)
}

export function validatePayload(
  type: string,
  value: JsonValue | undefined,
  path: string,
): Reply | null {
  if (!isObject(value)) return validation(`${path} should be an object.`)
  for (const field of ['rich_text', 'caption', 'cells']) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      return validation(`${path}.${field} should be an array.`)
    }
  }
  for (const field of ['is_toggleable', 'checked', 'has_column_header', 'has_row_header']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') {
      return validation(`${path}.${field} should be a boolean.`)
    }
  }
  if (!BLOCK_TYPES.has(type)) return validation(`${path} is not a supported block type.`)
  return null
}

export function validateChildren(
  value: JsonValue | undefined,
  path = 'body.children',
  depth = 0,
): BlockSpec[] | Reply {
  if (!Array.isArray(value)) return validation(`${path} should be an array.`)
  if (value.length > 100) return validation(`${path} should contain at most 100 blocks.`)
  if (depth > 2 && value.length > 0) return validation(`${path} exceeds the maximum nesting depth.`)
  const specs: BlockSpec[] = []
  for (const [index, child] of value.entries()) {
    const at = `${path}[${index}]`
    if (!isObject(child)) return validation(`${at} should be an object.`)
    if (child.type !== undefined && typeof child.type !== 'string')
      return validation(`${at}.type should be a string.`)
    const type =
      typeof child.type === 'string'
        ? child.type
        : Object.keys(child).find((key) => BLOCK_TYPES.has(key))
    if (type === undefined || type === '') return validation(`${at}.type should be defined.`)
    if (type === 'child_page' || type === 'child_database') {
      return validation(
        `Use the ${type === 'child_page' ? 'page' : 'database'} endpoint to create this block.`,
      )
    }
    if (child.object !== undefined && child.object !== 'block')
      return validation(`${at}.object should be "block".`)
    const value = child[type]
    const error = validatePayload(type, value, `${at}.${type}`)
    if (error !== null) return error
    const payload = { ...(value as Json) }
    let children: BlockSpec[] = []
    if (payload.children !== undefined) {
      if (!supportsChildren(type, payload))
        return validation(`${type} blocks cannot have children.`)
      const nested = validateChildren(payload.children, `${at}.${type}.children`, depth + 1)
      if (!Array.isArray(nested)) return nested
      children = nested
      delete payload.children
    }
    if (HEADINGS.has(type)) payload.is_toggleable ??= false
    specs.push({ type, payload, children })
  }
  return specs
}
