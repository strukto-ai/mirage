export const SCOPE_ERROR = 5000
export const DEFAULT_CHUNK_SIZE = 8192

export const QUOTA_PROPFIND =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:quota-available-bytes/><d:quota-used-bytes/>' +
  '</d:prop></d:propfind>'
// The quota-available-bytes Nextcloud answers for a user with no quota.
export const SPACE_UNLIMITED = -3

export const CHECKSUM_PROPFIND =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' +
  '<d:prop><d:resourcetype/><oc:checksums/></d:prop></d:propfind>'
// The hashlib names Nextcloud keeps a digest under, each with the type it
// names it by in `oc:checksums` and the digest's length in hex.
export const CHECKSUM_TYPES: Readonly<Record<string, readonly [string, number]>> = {
  md5: ['MD5', 32],
  sha1: ['SHA1', 40],
  sha256: ['SHA256', 64],
}
