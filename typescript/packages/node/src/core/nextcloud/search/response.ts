import { XMLParser } from 'fast-xml-parser'
import { SyntaxValidator } from 'fast-xml-validator'
import { CONTENT_LENGTH, LAST_MODIFIED, RESOURCE_TYPE } from './constants.ts'
import { relativePath } from './target.ts'
import type { Property, SearchEntry, SearchTarget, XmlRecord } from './types.ts'

export const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
})

function isRecord(value: unknown): value is XmlRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function records(value: unknown): XmlRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  return isRecord(value) ? [value] : []
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return null
}

function successfulProperties(response: XmlRecord): XmlRecord[] {
  const properties: XmlRecord[] = []
  for (const propstat of records(response.propstat)) {
    const status = stringValue(propstat.status) ?? ''
    const fields = status.split(/\s+/)
    if (fields[1] === '200' && isRecord(propstat.prop)) properties.push(propstat.prop)
  }
  if (properties.length === 0) {
    throw new Error('Nextcloud Files Search result has no successful properties')
  }
  return properties
}

function findText(properties: XmlRecord[], field: Property): string | null {
  for (const propertySet of properties) {
    const value = stringValue(propertySet[field.name])
    if (value !== null) return value
  }
  return null
}

function hasCollection(properties: XmlRecord[]): boolean {
  return properties.some((propertySet) => {
    const resourceType = propertySet[RESOURCE_TYPE.name]
    return isRecord(resourceType) && 'collection' in resourceType
  })
}

// A getlastmodified value as the time a listing records: RFC 3339 in UTC to the
// second, which is all the header carries.
function modifiedText(value: string | null): string | null {
  if (value === null) return null
  const milliseconds = Date.parse(value)
  if (Number.isNaN(milliseconds)) {
    throw new Error(`invalid Nextcloud Files Search timestamp: ${value}`)
  }
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function contentLength(properties: XmlRecord[]): number | null {
  const value = findText(properties, CONTENT_LENGTH)
  if (value === null) return null
  const size = Number(value)
  if (!Number.isInteger(size)) throw new Error(`invalid Nextcloud Files Search size: ${value}`)
  return size
}

function parseResponse(response: XmlRecord, target: SearchTarget): SearchEntry {
  const href = stringValue(response.href)
  if (href === null) throw new Error('Nextcloud Files Search result is missing href')
  const properties = successfulProperties(response)
  const folder = hasCollection(properties)
  return {
    key: relativePath(href, target),
    kind: folder ? 'd' : 'f',
    size: folder ? null : contentLength(properties),
    modified: modifiedText(findText(properties, LAST_MODIFIED)),
  }
}

function validateXml(content: string): void {
  try {
    const validation = SyntaxValidator.validate(content)
    if (validation !== true) throw new Error(validation.err.msg)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid Nextcloud Files Search XML: ${message}`, { cause: error })
  }
}

export function parsePage(content: string, target: SearchTarget): SearchEntry[] {
  validateXml(content)
  const parsed = parser.parse(content) as unknown
  if (!isRecord(parsed) || !('multistatus' in parsed)) {
    throw new Error('invalid Nextcloud Files Search response')
  }
  const multistatus = parsed.multistatus
  if (multistatus === '') return []
  if (!isRecord(multistatus)) throw new Error('invalid Nextcloud Files Search response')
  return records(multistatus.response).map((response) => parseResponse(response, target))
}
