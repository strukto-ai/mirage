from http import HTTPStatus

from mirage.core.nextcloud.search.types import Namespace, Property

DISPLAY_NAME = Property(Namespace.DAV, "displayname")
RESOURCE_TYPE = Property(Namespace.DAV, "resourcetype")
CONTENT_LENGTH = Property(Namespace.DAV, "getcontentlength")
LAST_MODIFIED = Property(Namespace.DAV, "getlastmodified")
SIZE = Property(Namespace.OWNCLOUD, "size")
SELECT_PROPERTIES = (
    DISPLAY_NAME,
    RESOURCE_TYPE,
    CONTENT_LENGTH,
    LAST_MODIFIED,
    SIZE,
)
ORDER_PROPERTIES = (DISPLAY_NAME, LAST_MODIFIED, SIZE)
SEARCH_METHOD = "SEARCH"
SEARCH_ENDPOINT_PATH = "/remote.php/dav/"
SEARCH_DEPTH = "infinity"
SEARCH_PAGE_SIZE = 100
SEARCH_HEADERS = {
    "Accept": "application/xml",
    "Content-Type": "text/xml; charset=utf-8",
}
UNAVAILABLE_STATUS_CODES = frozenset({
    HTTPStatus.NOT_FOUND,
    HTTPStatus.METHOD_NOT_ALLOWED,
    HTTPStatus.NOT_IMPLEMENTED,
})
