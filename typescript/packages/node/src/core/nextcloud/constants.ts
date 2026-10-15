export const SCOPE_ERROR = 5000
export const DEFAULT_CHUNK_SIZE = 8192

export const QUOTA_PROPFIND =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:quota-available-bytes/><d:quota-used-bytes/>' +
  '</d:prop></d:propfind>'
// The quota-available-bytes Nextcloud answers for a user with no quota.
export const SPACE_UNLIMITED = -3
