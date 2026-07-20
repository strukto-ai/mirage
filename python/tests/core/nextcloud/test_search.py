from xml.etree import ElementTree

import httpx
import pytest

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.commands.builtin.find_eval import (And, Name, Not, Or, Path,
                                               TrueNode, Type)
from mirage.core.nextcloud.search import (Bounds, FilesSearchQuery,
                                          search_files, supports_query)
from mirage.core.nextcloud.search.constants import SEARCH_PAGE_SIZE
from mirage.core.nextcloud.search.query import glob_to_like, request_body
from mirage.core.nextcloud.search.target import relative_path, search_target
from mirage.resource.nextcloud import NextcloudConfig
from mirage.types import FindType, PathSpec

_DAV_NAMESPACE = "DAV:"
_OWNCLOUD_NAMESPACE = "http://owncloud.org/ns"
_SEARCHDAV_NAMESPACE = "https://github.com/icewind1991/SearchDAV/ns"


def _qname(namespace: str, name: str) -> str:
    return f"{{{namespace}}}{name}"


def _multistatus(paths: list[tuple[str, bool]]) -> bytes:
    root = ElementTree.Element(_qname(_DAV_NAMESPACE, "multistatus"))
    for href_value, is_dir in paths:
        response = ElementTree.SubElement(root,
                                          _qname(_DAV_NAMESPACE, "response"))
        href = ElementTree.SubElement(response, _qname(_DAV_NAMESPACE, "href"))
        href.text = href_value
        propstat = ElementTree.SubElement(response,
                                          _qname(_DAV_NAMESPACE, "propstat"))
        prop = ElementTree.SubElement(propstat, _qname(_DAV_NAMESPACE, "prop"))
        displayname = ElementTree.SubElement(
            prop, _qname(_DAV_NAMESPACE, "displayname"))
        displayname.text = href_value.rstrip("/").rsplit("/", 1)[-1]
        resource_type = ElementTree.SubElement(
            prop, _qname(_DAV_NAMESPACE, "resourcetype"))
        if is_dir:
            ElementTree.SubElement(resource_type,
                                   _qname(_DAV_NAMESPACE, "collection"))
        content_length = ElementTree.SubElement(
            prop, _qname(_DAV_NAMESPACE, "getcontentlength"))
        content_length.text = "42"
        size = ElementTree.SubElement(prop, _qname(_OWNCLOUD_NAMESPACE,
                                                   "size"))
        size.text = "42"
        modified = ElementTree.SubElement(
            prop, _qname(_DAV_NAMESPACE, "getlastmodified"))
        modified.text = "Sat, 11 Jul 2026 12:00:00 GMT"
        status = ElementTree.SubElement(propstat,
                                        _qname(_DAV_NAMESPACE, "status"))
        status.text = "HTTP/1.1 200 OK"
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)


def test_search_target_preserves_webroot_and_configured_subroot():
    target = search_target(
        "https://cloud.example/nextcloud/remote.php/dav/files/alice/"
        "team%20docs/")
    assert target is not None
    assert target.endpoint == "https://cloud.example/nextcloud/remote.php/dav/"
    assert target.resource_scope == "/files/alice/team docs"


def test_search_target_rejects_non_nextcloud_url():
    assert search_target("https://cloud.example/webdav/") is None


def test_relative_path_preserves_literal_percent_in_subroot():
    target = search_target(
        "https://cloud.example/nextcloud/remote.php/dav/files/alice/"
        "team%2520docs/")
    assert target is not None
    assert target.resource_scope == "/files/alice/team%20docs"
    assert relative_path(
        "/nextcloud/remote.php/dav/files/alice/team%2520docs/report.pdf",
        target,
    ) == "/report.pdf"


def test_scope_preserves_spaces_unicode_and_xml_escapes_ampersand():
    target = search_target(
        "https://cloud.example/remote.php/dav/files/alice/team%20docs/")
    assert target is not None
    body = ElementTree.fromstring(
        request_body(
            target,
            PathSpec.from_str_path("/My Documents/税 & VAT"),
            FilesSearchQuery(tree=Name("Invoices")),
            0,
        ))
    assert body.findtext(".//" + _qname(_DAV_NAMESPACE, "scope") + "/" +
                         _qname(_DAV_NAMESPACE, "href")
                         ) == "/files/alice/team docs/My Documents/税 & VAT"


def test_glob_to_like_broadens_sql_wildcard_and_backslash_literals():
    assert glob_to_like("a_b%\\c?*") == "a_b%%c_%"


@pytest.mark.parametrize(
    "tree",
    [
        Or([Name("*.pdf"), Path("*/deep/*")]),
        Not(And([Name("*.pdf"), Path("*/deep/*")])),
    ],
)
def test_query_rejects_partially_representable_boolean_tree(tree):
    assert not supports_query(FilesSearchQuery(tree=tree))


def test_query_accepts_fully_representable_boolean_tree():
    tree = Or([Name("*.pdf"), Not(Type("d"))])
    assert supports_query(FilesSearchQuery(tree=tree))


def test_positive_size_query_excludes_directories():
    target = search_target("https://cloud.example/remote.php/dav/files/alice/")
    assert target is not None
    body = ElementTree.fromstring(
        request_body(
            target,
            PathSpec.from_str_path("/Accounting"),
            FilesSearchQuery(tree=TrueNode(), size=Bounds(lower=10)),
            0,
        ))
    where = body.find(".//" + _qname(_DAV_NAMESPACE, "where"))
    assert where is not None
    assert where.find("./" + _qname(_DAV_NAMESPACE, "or")) is None


@pytest.mark.asyncio
async def test_search_files_builds_query_and_paginates(make_acc, httpx_mock):
    first_paths = [(f"/remote.php/dav/files/user/Accounting/item-{index}.pdf",
                    True) for index in range(SEARCH_PAGE_SIZE)]
    second_paths = [("/files/user/Accounting/final%20invoice.pdf", True)]
    httpx_mock.add_response(method="SEARCH",
                            status_code=207,
                            content=_multistatus(first_paths))
    httpx_mock.add_response(method="SEARCH",
                            status_code=207,
                            content=_multistatus(second_paths))
    accessor = make_acc({})
    query = FilesSearchQuery(
        tree=And([Name("*.pdf"), Type("d")]),
        size=Bounds(lower=10, upper=100),
        modified=Bounds(lower=1000.75, upper=2000.25),
    )

    entries = await search_files(accessor,
                                 PathSpec.from_str_path("/Accounting"), query)

    assert entries is not None
    assert len(entries) == SEARCH_PAGE_SIZE + 1
    assert entries[-1].key == "/Accounting/final invoice.pdf"
    assert entries[-1].kind == FindType.DIRECTORY
    assert entries[-1].size == 42
    requests = httpx_mock.get_requests()
    assert len(requests) == 2
    assert requests[0].method == "SEARCH"
    assert str(requests[0].url) == "https://cloud.example.com/remote.php/dav/"
    assert requests[0].headers["authorization"].startswith("Basic ")
    assert requests[0].headers["content-type"].startswith("text/xml")
    first_body = ElementTree.fromstring(requests[0].content)
    second_body = ElementTree.fromstring(requests[1].content)
    assert first_body.findtext(
        ".//" + _qname(_DAV_NAMESPACE, "scope") + "/" +
        _qname(_DAV_NAMESPACE, "href")) == "/files/user/Accounting"
    assert first_body.findtext(
        ".//" + _qname(_SEARCHDAV_NAMESPACE, "firstresult")) == "0"
    assert second_body.findtext(
        ".//" +
        _qname(_SEARCHDAV_NAMESPACE, "firstresult")) == str(SEARCH_PAGE_SIZE)
    assert first_body.find(".//" +
                           _qname(_DAV_NAMESPACE, "is-collection")) is not None
    literals = [
        element.text
        for element in first_body.findall(".//" +
                                          _qname(_DAV_NAMESPACE, "literal"))
    ]
    assert "%.pdf" in literals
    assert "10" in literals
    assert "100" in literals
    assert "1000" in literals
    assert "2001" in literals


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [404, 405, 501])
async def test_search_files_returns_none_when_search_is_unavailable(
        make_acc, httpx_mock, status_code):
    httpx_mock.add_response(method="SEARCH", status_code=status_code)
    result = await search_files(
        make_acc({}),
        PathSpec.from_str_path("/Documents"),
        FilesSearchQuery(tree=Name("Invoices")),
    )
    assert result is None


@pytest.mark.asyncio
async def test_search_files_stops_when_pagination_makes_no_progress(
        make_acc, httpx_mock):
    paths = [(f"/files/user/Documents/item-{index}", False)
             for index in range(SEARCH_PAGE_SIZE)]
    page = _multistatus(paths)
    httpx_mock.add_response(method="SEARCH", status_code=207, content=page)
    httpx_mock.add_response(method="SEARCH", status_code=207, content=page)

    result = await search_files(
        make_acc({}),
        PathSpec.from_str_path("/Documents"),
        FilesSearchQuery(tree=Name("item-*")),
    )

    assert result is None
    assert len(httpx_mock.get_requests()) == 2


@pytest.mark.asyncio
async def test_search_files_rebases_configured_subroot(httpx_mock):
    accessor = NextcloudAccessor(
        NextcloudConfig(
            url=("https://cloud.example/remote.php/dav/files/alice/"
                 "team%20docs/"),
            username="alice",
            password="secret",
        ))
    httpx_mock.add_response(
        method="SEARCH",
        status_code=207,
        content=_multistatus([
            ("/files/alice/team%20docs/Reports/Q1%20invoice.pdf", False)
        ]),
    )

    entries = await search_files(
        accessor,
        PathSpec.from_str_path("/Reports"),
        FilesSearchQuery(tree=Name("*.pdf")),
    )

    assert entries is not None
    assert [entry.key for entry in entries] == ["/Reports/Q1 invoice.pdf"]
    request = httpx_mock.get_requests()[0]
    body = ElementTree.fromstring(request.content)
    assert body.findtext(
        ".//" + _qname(_DAV_NAMESPACE, "scope") + "/" +
        _qname(_DAV_NAMESPACE, "href")) == "/files/alice/team docs/Reports"


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [401, 500])
async def test_search_files_propagates_http_error(make_acc, httpx_mock,
                                                  status_code):
    httpx_mock.add_response(method="SEARCH", status_code=status_code)
    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await search_files(
            make_acc({}),
            PathSpec.from_str_path("/Documents"),
            FilesSearchQuery(tree=Name("Invoices")),
        )
    assert exc_info.value.response.status_code == status_code


@pytest.mark.asyncio
async def test_search_files_rejects_malformed_multistatus(
        make_acc, httpx_mock):
    httpx_mock.add_response(method="SEARCH",
                            status_code=207,
                            content=b"<not-xml")
    with pytest.raises(ElementTree.ParseError):
        await search_files(
            make_acc({}),
            PathSpec.from_str_path("/Documents"),
            FilesSearchQuery(tree=Name("Invoices")),
        )


@pytest.mark.asyncio
async def test_search_files_rejects_out_of_scope_href(make_acc, httpx_mock):
    httpx_mock.add_response(
        method="SEARCH",
        status_code=207,
        content=_multistatus([("/files/other/Documents/Invoices", True)]),
    )
    with pytest.raises(ValueError, match="out-of-scope href"):
        await search_files(
            make_acc({}),
            PathSpec.from_str_path("/Documents"),
            FilesSearchQuery(tree=Name("Invoices")),
        )
