import type { PathSpec } from '@struktoai/mirage-core/types'
import { ORDER_PROPERTIES, SEARCH_DEPTH, SEARCH_PAGE_SIZE, SELECT_PROPERTIES } from './constants.ts'
import { scopePath } from './target.ts'
import { Namespace, type Property, type SearchTarget } from './types.ts'

function escapeXml(value: string | number): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function propertyTag(field: Property): string {
  return `<${field.prefix}:${field.name}/>`
}

function property(field: Property): string {
  return `<d:prop>${propertyTag(field)}</d:prop>`
}

// A condition every file and folder meets, since Nextcloud's search refuses a
// request with none. Mirrors Python's `every_entry`.
function everyEntry(): string {
  return '<d:or><d:is-collection/><d:not><d:is-collection/></d:not></d:or>'
}

function order(field: Property): string {
  return `<d:order>${property(field)}<d:ascending/></d:order>`
}

/** One page of every file and folder under `path`. */
export function requestBody(target: SearchTarget, path: PathSpec, offset: number): string {
  const selected = SELECT_PROPERTIES.map(propertyTag).join('')
  const ordered = ORDER_PROPERTIES.map(order).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><d:searchrequest xmlns:d="${Namespace.DAV}" xmlns:oc="${Namespace.OWNCLOUD}" xmlns:sd="${Namespace.SEARCHDAV}"><d:basicsearch><d:select><d:prop>${selected}</d:prop></d:select><d:from><d:scope><d:href>${escapeXml(scopePath(target, path))}</d:href><d:depth>${SEARCH_DEPTH}</d:depth></d:scope></d:from><d:where>${everyEntry()}</d:where><d:orderby>${ordered}</d:orderby><d:limit><d:nresults>${String(SEARCH_PAGE_SIZE)}</d:nresults><sd:firstresult>${String(offset)}</sd:firstresult></d:limit></d:basicsearch></d:searchrequest>`
}
