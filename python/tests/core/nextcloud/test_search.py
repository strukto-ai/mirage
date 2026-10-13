from xml.etree import ElementTree

import httpx
import pytest

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.search import search_files
from mirage.core.nextcloud.search.constants import SEARCH_PAGE_SIZE
from mirage.core.nextcloud.search.query import request_body
from mirage.core.nextcloud.search.target import relative_path, search_target
from mirage.types import FindType, PathSpec
from mirage.vfs.nextcloud import NextcloudConfig

_DAV_NAMESPACE = "DAV:"
_SEARCHDAV_NAMESPACE = "https://github.com/icewind1991/SearchDAV/ns"


def _qname(namespace: str, name: str) -> str:
    return f"{{{namespace}}}{name}"


def _multistatus(paths: list[tuple[str, bool]]) -> bytes:
    root = ElementTree.Element(_qname(_DAV_NAMESPACE, "multistatus"))
    for href_value, is_dir in paths:
        response = ElementTree.SubElement(
            root, _qname(_DAV_NAMESPACE, "response")
        )
        href = ElementTree.SubElement(response, _qname(_DAV_NAMESPACE, "href"))
        href.text = href_value
        propstat = ElementTree.SubElement(
            response, _qname(_DAV_NAMESPACE, "propstat")
        )
        prop = ElementTree.SubElement(propstat, _qname(_DAV_NAMESPACE, "prop"))
        resource_type = ElementTree.SubElement(
            prop, _qname(_DAV_NAMESPACE, "resourcetype")
        )
        if is_dir:
            ElementTree.SubElement(
                resource_type, _qname(_DAV_NAMESPACE, "collection")
            )
        if not is_dir:
            content_length = ElementTree.SubElement(
                prop, _qname(_DAV_NAMESPACE, "getcontentlength")
            )
            content_length.text = "42"
        modified = ElementTree.SubElement(
            prop, _qname(_DAV_NAMESPACE, "getlastmodified")
        )
        modified.text = "Sat, 11 Jul 2026 12:00:00 GMT"
        status = ElementTree.SubElement(
            propstat, _qname(_DAV_NAMESPACE, "status")
        )
        status.text = "HTTP/1.1 200 OK"
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)


def test_search_target_preserves_webroot_and_configured_subroot():
    target = search_target(
        "https://cloud.example/nextcloud/remote.php/dav/files/alice/"
        "team%20docs/"
    )
    assert target is not None
    assert target.endpoint == "https://cloud.example/nextcloud/remote.php/dav/"
    assert target.vfs_scope == "/files/alice/team docs"


def test_search_target_rejects_non_nextcloud_url():
    assert search_target("https://cloud.example/webdav/") is None


def test_relative_path_preserves_literal_percent_in_subroot():
    target = search_target(
        "https://cloud.example/nextcloud/remote.php/dav/files/alice/"
        "team%2520docs/"
    )
    assert target is not None
    assert target.vfs_scope == "/files/alice/team%20docs"
    assert (
        relative_path(
            "/nextcloud/remote.php/dav/files/alice/team%2520docs/report.pdf",
            target,
        )
        == "/report.pdf"
    )


def test_scope_preserves_spaces_unicode_and_xml_escapes_ampersand():
    target = search_target(
        "https://cloud.example/remote.php/dav/files/alice/team%20docs/"
    )
    assert target is not None
    body = ElementTree.fromstring(
        request_body(
            target,
            PathSpec.from_str_path("/My Documents/税 & VAT"),
            0,
        )
    )
    assert (
        body.findtext(
            ".//"
            + _qname(_DAV_NAMESPACE, "scope")
            + "/"
            + _qname(_DAV_NAMESPACE, "href")
        )
        == "/files/alice/team docs/My Documents/税 & VAT"
    )


@pytest.mark.asyncio
async def test_search_files_lists_every_entry_a_page_at_a_time(
    make_acc, httpx_mock
):
    first_paths = [
        (f"/remote.php/dav/files/user/Accounting/item-{index}.pdf", False)
        for index in range(SEARCH_PAGE_SIZE)
    ]
    second_paths = [("/files/user/Accounting/final%20invoices/", True)]
    httpx_mock.add_response(
        method="SEARCH", status_code=207, content=_multistatus(first_paths)
    )
    httpx_mock.add_response(
        method="SEARCH", status_code=207, content=_multistatus(second_paths)
    )

    entries = await search_files(
        make_acc({}), PathSpec.from_str_path("/Accounting")
    )

    assert entries is not None
    assert len(entries) == SEARCH_PAGE_SIZE + 1
    assert (entries[0].kind, entries[0].size, entries[0].modified) == (
        FindType.FILE,
        42,
        "2026-07-11T12:00:00+00:00",
    )
    assert (entries[-1].key, entries[-1].kind, entries[-1].size) == (
        "/Accounting/final invoices",
        FindType.DIRECTORY,
        None,
    )
    requests = httpx_mock.get_requests()
    assert len(requests) == 2
    assert requests[0].method == "SEARCH"
    assert str(requests[0].url) == "https://cloud.example.com/remote.php/dav/"
    assert requests[0].headers["authorization"].startswith("Basic ")
    assert requests[0].headers["content-type"].startswith("text/xml")
    first_body = ElementTree.fromstring(requests[0].content)
    second_body = ElementTree.fromstring(requests[1].content)
    assert (
        first_body.findtext(
            ".//"
            + _qname(_DAV_NAMESPACE, "scope")
            + "/"
            + _qname(_DAV_NAMESPACE, "href")
        )
        == "/files/user/Accounting"
    )
    assert [
        body.findtext(".//" + _qname(_SEARCHDAV_NAMESPACE, "firstresult"))
        for body in (first_body, second_body)
    ] == ["0", str(SEARCH_PAGE_SIZE)]
    assert first_body.findtext(
        ".//" + _qname(_DAV_NAMESPACE, "nresults")
    ) == str(SEARCH_PAGE_SIZE)
    where = first_body.find(".//" + _qname(_DAV_NAMESPACE, "where"))
    assert where is not None
    assert [element.tag.split("}")[1] for element in where.iter()] == [
        "where",
        "or",
        "is-collection",
        "not",
        "is-collection",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [404, 405, 500, 501])
async def test_search_files_returns_none_when_search_is_unavailable(
    make_acc, httpx_mock, status_code
):
    httpx_mock.add_response(method="SEARCH", status_code=status_code)
    result = await search_files(
        make_acc({}),
        PathSpec.from_str_path("/Documents"),
    )
    assert result is None


@pytest.mark.asyncio
async def test_search_files_stops_when_pagination_makes_no_progress(
    make_acc, httpx_mock
):
    paths = [
        (f"/files/user/Documents/item-{index}", False)
        for index in range(SEARCH_PAGE_SIZE)
    ]
    page = _multistatus(paths)
    httpx_mock.add_response(method="SEARCH", status_code=207, content=page)
    httpx_mock.add_response(method="SEARCH", status_code=207, content=page)

    result = await search_files(
        make_acc({}),
        PathSpec.from_str_path("/Documents"),
    )

    assert result is None
    assert len(httpx_mock.get_requests()) == 2


@pytest.mark.asyncio
async def test_search_files_rebases_configured_subroot(httpx_mock):
    accessor = NextcloudAccessor(
        NextcloudConfig(
            url=(
                "https://cloud.example/remote.php/dav/files/alice/team%20docs/"
            ),
            username="alice",
            password="secret",
        )
    )
    httpx_mock.add_response(
        method="SEARCH",
        status_code=207,
        content=_multistatus(
            [("/files/alice/team%20docs/Reports/Q1%20invoice.pdf", False)]
        ),
    )

    entries = await search_files(
        accessor,
        PathSpec.from_str_path("/Reports"),
    )

    assert entries is not None
    assert [entry.key for entry in entries] == ["/Reports/Q1 invoice.pdf"]
    request = httpx_mock.get_requests()[0]
    body = ElementTree.fromstring(request.content)
    assert (
        body.findtext(
            ".//"
            + _qname(_DAV_NAMESPACE, "scope")
            + "/"
            + _qname(_DAV_NAMESPACE, "href")
        )
        == "/files/alice/team docs/Reports"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [401, 503])
async def test_search_files_propagates_http_error(
    make_acc, httpx_mock, status_code
):
    httpx_mock.add_response(method="SEARCH", status_code=status_code)
    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await search_files(
            make_acc({}),
            PathSpec.from_str_path("/Documents"),
        )
    assert exc_info.value.response.status_code == status_code


@pytest.mark.asyncio
async def test_search_files_rejects_malformed_multistatus(
    make_acc, httpx_mock
):
    httpx_mock.add_response(
        method="SEARCH", status_code=207, content=b"<not-xml"
    )
    with pytest.raises(ElementTree.ParseError):
        await search_files(
            make_acc({}),
            PathSpec.from_str_path("/Documents"),
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
        )
