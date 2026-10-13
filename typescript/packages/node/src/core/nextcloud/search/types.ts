export const Namespace = {
  DAV: 'DAV:',
  OWNCLOUD: 'http://owncloud.org/ns',
  SEARCHDAV: 'https://github.com/icewind1991/SearchDAV/ns',
} as const

export interface Property {
  namespace: (typeof Namespace)[keyof typeof Namespace]
  prefix: 'd' | 'oc'
  name: string
}

export interface SearchEntry {
  key: string
  kind: 'f' | 'd'
  size: number | null
  modified: string | null
}

export interface SearchTarget {
  endpoint: string
  vfsScope: string
}

export type XmlRecord = Record<string, unknown>
