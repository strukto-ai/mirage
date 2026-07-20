import { Namespace, type Property } from './types.ts'

export const DISPLAY_NAME: Property = {
  namespace: Namespace.DAV,
  prefix: 'd',
  name: 'displayname',
}
export const RESOURCE_TYPE: Property = {
  namespace: Namespace.DAV,
  prefix: 'd',
  name: 'resourcetype',
}
export const CONTENT_LENGTH: Property = {
  namespace: Namespace.DAV,
  prefix: 'd',
  name: 'getcontentlength',
}
export const LAST_MODIFIED: Property = {
  namespace: Namespace.DAV,
  prefix: 'd',
  name: 'getlastmodified',
}
export const SIZE: Property = {
  namespace: Namespace.OWNCLOUD,
  prefix: 'oc',
  name: 'size',
}
export const SELECT_PROPERTIES = [DISPLAY_NAME, RESOURCE_TYPE, CONTENT_LENGTH, LAST_MODIFIED, SIZE]
export const ORDER_PROPERTIES = [DISPLAY_NAME, LAST_MODIFIED, SIZE]
export const SEARCH_METHOD = 'SEARCH'
export const SEARCH_ENDPOINT_PATH = '/remote.php/dav/'
export const SEARCH_DEPTH = 'infinity'
export const SEARCH_PAGE_SIZE = 100
export const SEARCH_HEADERS = {
  Accept: 'application/xml',
  'Content-Type': 'text/xml; charset=utf-8',
}
export const UNAVAILABLE_STATUS_CODES = new Set([404, 405, 501])
