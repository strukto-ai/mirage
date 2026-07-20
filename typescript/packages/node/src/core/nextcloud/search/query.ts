import type { PathSpec, PredNode } from '@struktoai/mirage-core'
import {
  DISPLAY_NAME,
  LAST_MODIFIED,
  ORDER_PROPERTIES,
  SEARCH_DEPTH,
  SEARCH_PAGE_SIZE,
  SELECT_PROPERTIES,
  SIZE,
} from './constants.ts'
import { scopePath } from './target.ts'
import {
  BooleanOperation,
  Comparison,
  Namespace,
  type BooleanOperator,
  type ComparisonOperator,
  type CompiledPredicate,
  type FilesSearchQuery,
  type Property,
  type SearchTarget,
} from './types.ts'

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

function comparison(
  operation: ComparisonOperator,
  field: Property,
  value: string | number,
): string {
  return `<d:${operation}>${property(field)}<d:literal>${escapeXml(value)}</d:literal></d:${operation}>`
}

function isCollection(): string {
  return '<d:is-collection/>'
}

function negate(condition: string): string {
  return `<d:not>${condition}</d:not>`
}

function combine(operation: BooleanOperator, conditions: string[]): string {
  const [only] = conditions
  if (only !== undefined && conditions.length === 1) return only
  return `<d:${operation}>${conditions.join('')}</d:${operation}>`
}

export function globToLike(pattern: string): string {
  let translated = ''
  for (const character of pattern) {
    if (character === '*') translated += '%'
    else if (character === '?') translated += '_'
    else if (character === '\\') translated += '%'
    else translated += character
  }
  return translated
}

function nameCondition(node: Extract<PredNode, { op: 'name' }>): string {
  const wildcard = node.pattern.includes('*') || node.pattern.includes('?')
  const operation = wildcard || node.icase ? Comparison.LIKE : Comparison.EQUAL
  const value = operation === Comparison.LIKE ? globToLike(node.pattern) : node.pattern
  return comparison(operation, DISPLAY_NAME, value)
}

function compilePredicate(node: PredNode): CompiledPredicate | null {
  switch (node.op) {
    case 'true':
      return { condition: null }
    case 'name':
      return node.pattern.includes('[') ? null : { condition: nameCondition(node) }
    case 'type':
      if (node.kind === 'd') return { condition: isCollection() }
      if (node.kind === 'f') return { condition: negate(isCollection()) }
      return null
    case 'not': {
      const compiled = compilePredicate(node.kid)
      return compiled?.condition != null ? { condition: negate(compiled.condition) } : null
    }
    case 'and':
    case 'or': {
      const conditions: string[] = []
      for (const kid of node.kids) {
        const compiled = compilePredicate(kid)
        if (compiled === null) return null
        if (compiled.condition === null) {
          if (node.op === 'or') return null
          continue
        }
        conditions.push(compiled.condition)
      }
      if (conditions.length === 0) return node.op === 'and' ? { condition: null } : null
      const operation = node.op === 'and' ? BooleanOperation.AND : BooleanOperation.OR
      return { condition: combine(operation, conditions) }
    }
    case 'path':
    case 'empty':
      return null
  }
}

function sizeCondition(query: FilesSearchQuery): string | null {
  const size = query.size
  if (size === undefined) return null
  const conditions: string[] = []
  if (size.lower !== null && size.lower === size.upper) {
    conditions.push(comparison(Comparison.EQUAL, SIZE, size.lower))
  } else {
    if (size.lower !== null) {
      conditions.push(comparison(Comparison.GREATER_THAN_OR_EQUAL, SIZE, size.lower))
    }
    if (size.upper !== null) {
      conditions.push(comparison(Comparison.LESS_THAN_OR_EQUAL, SIZE, size.upper))
    }
  }
  if (conditions.length === 0) return null
  const fileBounds = combine(BooleanOperation.AND, [negate(isCollection()), ...conditions])
  const includesZero =
    (size.lower === null || size.lower <= 0) && (size.upper === null || size.upper >= 0)
  return includesZero ? combine(BooleanOperation.OR, [isCollection(), fileBounds]) : fileBounds
}

function whereCondition(query: FilesSearchQuery): string | null {
  const compiled = compilePredicate(query.tree)
  if (compiled === null) return null
  const conditions: string[] = []
  if (compiled.condition !== null) conditions.push(compiled.condition)
  const size = sizeCondition(query)
  if (size !== null) conditions.push(size)
  if (query.modified?.lower != null) {
    conditions.push(
      comparison(Comparison.GREATER_THAN_OR_EQUAL, LAST_MODIFIED, Math.floor(query.modified.lower)),
    )
  }
  if (query.modified?.upper != null) {
    conditions.push(
      comparison(Comparison.LESS_THAN_OR_EQUAL, LAST_MODIFIED, Math.ceil(query.modified.upper)),
    )
  }
  return conditions.length > 0 ? combine(BooleanOperation.AND, conditions) : null
}

export function supportsQuery(query: FilesSearchQuery): boolean {
  return whereCondition(query) !== null
}

function order(field: Property): string {
  return `<d:order>${property(field)}<d:ascending/></d:order>`
}

export function requestBody(
  target: SearchTarget,
  path: PathSpec,
  query: FilesSearchQuery,
  offset: number,
): string {
  const condition = whereCondition(query)
  if (condition === null) throw new Error('Nextcloud Files Search requires a supported query')
  const selected = SELECT_PROPERTIES.map(propertyTag).join('')
  const ordered = ORDER_PROPERTIES.map(order).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><d:searchrequest xmlns:d="${Namespace.DAV}" xmlns:oc="${Namespace.OWNCLOUD}" xmlns:sd="${Namespace.SEARCHDAV}"><d:basicsearch><d:select><d:prop>${selected}</d:prop></d:select><d:from><d:scope><d:href>${escapeXml(scopePath(target, path))}</d:href><d:depth>${SEARCH_DEPTH}</d:depth></d:scope></d:from><d:where>${condition}</d:where><d:orderby>${ordered}</d:orderby><d:limit><d:nresults>${String(SEARCH_PAGE_SIZE)}</d:nresults><sd:firstresult>${String(offset)}</sd:firstresult></d:limit></d:basicsearch></d:searchrequest>`
}
