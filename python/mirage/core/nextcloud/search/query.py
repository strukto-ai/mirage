from typing import cast
from xml.etree import ElementTree

import mirage.core.nextcloud.search.constants as constants
from mirage.core.nextcloud.search.target import scope_path
from mirage.core.nextcloud.search.types import (
    Property,
    SearchTarget,
    XmlElement,
)
from mirage.core.nextcloud.search.xml import dav, searchdav
from mirage.types import PathSpec


def property_element(parent: XmlElement, field: Property) -> XmlElement:
    prop = ElementTree.SubElement(parent, dav("prop"))
    ElementTree.SubElement(prop, field.tag)
    return prop


def every_entry() -> XmlElement:
    """A condition every file and folder meets, since Nextcloud's search
    refuses a request with none."""
    either = ElementTree.Element(dav("or"))
    ElementTree.SubElement(either, dav("is-collection"))
    negated = ElementTree.SubElement(either, dav("not"))
    ElementTree.SubElement(negated, dav("is-collection"))
    return either


def order(parent: XmlElement, field: Property) -> None:
    element = ElementTree.SubElement(parent, dav("order"))
    property_element(element, field)
    ElementTree.SubElement(element, dav("ascending"))


def request_body(target: SearchTarget, path: PathSpec, offset: int) -> bytes:
    """One page of every file and folder under ``path``.

    Args:
        target (SearchTarget): the server's search endpoint and the
            mount's scope in it.
        path (PathSpec): the directory.
        offset (int): how many entries earlier pages held.
    """
    root = ElementTree.Element(dav("searchrequest"))
    basic = ElementTree.SubElement(root, dav("basicsearch"))
    select = ElementTree.SubElement(basic, dav("select"))
    props = ElementTree.SubElement(select, dav("prop"))
    for field in constants.SELECT_PROPERTIES:
        ElementTree.SubElement(props, field.tag)
    from_element = ElementTree.SubElement(basic, dav("from"))
    scope = ElementTree.SubElement(from_element, dav("scope"))
    href = ElementTree.SubElement(scope, dav("href"))
    href.text = scope_path(target, path)
    depth = ElementTree.SubElement(scope, dav("depth"))
    depth.text = constants.SEARCH_DEPTH
    where = ElementTree.SubElement(basic, dav("where"))
    where.append(every_entry())
    orderby = ElementTree.SubElement(basic, dav("orderby"))
    for field in constants.ORDER_PROPERTIES:
        order(orderby, field)
    limit = ElementTree.SubElement(basic, dav("limit"))
    count = ElementTree.SubElement(limit, dav("nresults"))
    count.text = str(constants.SEARCH_PAGE_SIZE)
    first = ElementTree.SubElement(limit, searchdav("firstresult"))
    first.text = str(offset)
    return cast(
        bytes,
        ElementTree.tostring(root, encoding="utf-8", xml_declaration=True),
    )
