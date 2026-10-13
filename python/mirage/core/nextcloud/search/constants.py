from http import HTTPStatus

from mirage.core.nextcloud.search.types import Namespace, Property

DISPLAY_NAME = Property(Namespace.DAV, "displayname")
RESOURCE_TYPE = Property(Namespace.DAV, "resourcetype")
CONTENT_LENGTH = Property(Namespace.DAV, "getcontentlength")
LAST_MODIFIED = Property(Namespace.DAV, "getlastmodified")
SIZE = Property(Namespace.OWNCLOUD, "size")
SELECT_PROPERTIES = (RESOURCE_TYPE, CONTENT_LENGTH, LAST_MODIFIED)
ORDER_PROPERTIES = (DISPLAY_NAME, LAST_MODIFIED, SIZE)
SEARCH_METHOD = "SEARCH"
SEARCH_ENDPOINT_PATH = "/remote.php/dav/"
SEARCH_DEPTH = "infinity"
SEARCH_PAGE_SIZE = 1000
SEARCH_HEADERS = {
    "Accept": "application/xml",
    "Content-Type": "text/xml; charset=utf-8",
}
# The answers that mean there is no search here, so the caller walks: no
# such path, a server without the search, and the 500 Nextcloud answers for
# a scope that is a file ("Search is only supported on directories").
UNAVAILABLE_STATUS_CODES = frozenset(
    {
        HTTPStatus.NOT_FOUND,
        HTTPStatus.METHOD_NOT_ALLOWED,
        HTTPStatus.INTERNAL_SERVER_ERROR,
        HTTPStatus.NOT_IMPLEMENTED,
    }
)
