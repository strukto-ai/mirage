SCOPE_ERROR = 5000
DEFAULT_CHUNK_SIZE = 8192

QUOTA_PROPFIND = (
    b'<?xml version="1.0" encoding="utf-8"?>'
    b'<d:propfind xmlns:d="DAV:"><d:prop>'
    b"<d:quota-available-bytes/><d:quota-used-bytes/>"
    b"</d:prop></d:propfind>"
)
# The quota-available-bytes Nextcloud answers for a user with no quota.
SPACE_UNLIMITED = -3
