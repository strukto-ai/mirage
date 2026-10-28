SCOPE_ERROR = 5000
DEFAULT_CHUNK_SIZE = 8192
# A write past one chunk goes up through Nextcloud's chunked upload, which
# takes at most 10,000 chunks of at least 5 MiB but the last.
UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024
MAX_UPLOAD_CHUNKS = 10000

QUOTA_PROPFIND = (
    b'<?xml version="1.0" encoding="utf-8"?>'
    b'<d:propfind xmlns:d="DAV:"><d:prop>'
    b"<d:quota-available-bytes/><d:quota-used-bytes/>"
    b"</d:prop></d:propfind>"
)
# The quota-available-bytes Nextcloud answers for a user with no quota.
SPACE_UNLIMITED = -3

CHECKSUM_PROPFIND = (
    b'<?xml version="1.0" encoding="utf-8"?>'
    b'<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">'
    b"<d:prop><d:resourcetype/><oc:checksums/></d:prop></d:propfind>"
)
# The hashlib names Nextcloud keeps a digest under, each with the type it
# names it by in ``oc:checksums`` and the digest's length in hex.
CHECKSUM_TYPES = {
    "md5": ("MD5", 32),
    "sha1": ("SHA1", 40),
    "sha256": ("SHA256", 64),
}
