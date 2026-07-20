import type { PredNode } from '@struktoai/mirage-core'

export const Namespace = {
  DAV: 'DAV:',
  OWNCLOUD: 'http://owncloud.org/ns',
  SEARCHDAV: 'https://github.com/icewind1991/SearchDAV/ns',
} as const

export const Comparison = {
  EQUAL: 'eq',
  GREATER_THAN_OR_EQUAL: 'gte',
  LESS_THAN_OR_EQUAL: 'lte',
  LIKE: 'like',
} as const

export const BooleanOperation = {
  AND: 'and',
  OR: 'or',
} as const

export interface Property {
  namespace: (typeof Namespace)[keyof typeof Namespace]
  prefix: 'd' | 'oc'
  name: string
}

export interface Bounds {
  lower: number | null
  upper: number | null
}

export interface FilesSearchQuery {
  tree: PredNode
  size?: Bounds
  modified?: Bounds
}

export interface SearchEntry {
  key: string
  name: string
  kind: 'f' | 'd'
  size: number | null
  modified: number | null
}

export interface SearchTarget {
  endpoint: string
  resourceScope: string
}

export interface CompiledPredicate {
  condition: string | null
}

export type ComparisonOperator = (typeof Comparison)[keyof typeof Comparison]
export type BooleanOperator = (typeof BooleanOperation)[keyof typeof BooleanOperation]
export type XmlRecord = Record<string, unknown>
