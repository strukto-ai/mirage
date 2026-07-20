from urllib.parse import unquote, urlsplit, urlunsplit

from mirage.core.nextcloud.search.constants import SEARCH_ENDPOINT_PATH
from mirage.core.nextcloud.search.types import SearchTarget
from mirage.types import PathSpec


def search_target(url: str) -> SearchTarget | None:
    parsed = urlsplit(url)
    marker = parsed.path.find(SEARCH_ENDPOINT_PATH)
    if marker < 0:
        return None
    dav_end = marker + len(SEARCH_ENDPOINT_PATH)
    relative = parsed.path[dav_end:].strip("/")
    parts = relative.split("/") if relative else []
    if len(parts) < 2 or parts[0] != "files":
        return None
    endpoint = urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path[:dav_end], "", ""))
    return SearchTarget(endpoint=endpoint,
                        resource_scope=unquote("/" + "/".join(parts)))


def scope_path(target: SearchTarget, path: PathSpec) -> str:
    relative = path.mount_path.strip("/")
    if not relative:
        return target.resource_scope
    return target.resource_scope.rstrip("/") + "/" + relative


def strip_scope(path: str, scope: str) -> str | None:
    if path == scope:
        return ""
    prefix = scope.rstrip("/") + "/"
    return path[len(prefix):] if path.startswith(prefix) else None


def relative_path(href: str, target: SearchTarget) -> str:
    href_path = unquote(urlsplit(href).path).rstrip("/")
    resource_scope = target.resource_scope.rstrip("/")
    relative = strip_scope(href_path, resource_scope)
    if relative is None:
        dav_root = unquote(urlsplit(target.endpoint).path).rstrip("/")
        relative = strip_scope(href_path, dav_root + resource_scope)
    if relative is None:
        raise ValueError(
            f"Nextcloud Files Search returned an out-of-scope href: {href}")
    return "/" + relative if relative else "/"
