import math
from xml.etree import ElementTree

import mirage.core.nextcloud.search.constants as constants
from mirage.commands.builtin.find_eval import (And, Name, Not, Or, PredNode,
                                               TrueNode, Type)
from mirage.core.nextcloud.search.target import scope_path
from mirage.core.nextcloud.search.types import (BooleanOperation, Comparison,
                                                CompiledPredicate,
                                                FilesSearchQuery, Property,
                                                SearchTarget, XmlElement)
from mirage.core.nextcloud.search.xml import dav, searchdav
from mirage.types import FindType, PathSpec


def property_element(parent: XmlElement, field: Property) -> XmlElement:
    prop = ElementTree.SubElement(parent, dav("prop"))
    ElementTree.SubElement(prop, field.tag)
    return prop


def comparison(operation: Comparison, field: Property,
               value: str | int) -> XmlElement:
    element = ElementTree.Element(dav(operation))
    property_element(element, field)
    literal = ElementTree.SubElement(element, dav("literal"))
    literal.text = str(value)
    return element


def is_collection() -> XmlElement:
    return ElementTree.Element(dav("is-collection"))


def negate(condition: XmlElement) -> XmlElement:
    element = ElementTree.Element(dav("not"))
    element.append(condition)
    return element


def not_collection() -> XmlElement:
    return negate(is_collection())


def combine(operation: BooleanOperation,
            elements: list[XmlElement]) -> XmlElement:
    if len(elements) == 1:
        return elements[0]
    combined = ElementTree.Element(dav(operation))
    combined.extend(elements)
    return combined


def glob_to_like(pattern: str) -> str:
    translated: list[str] = []
    for char in pattern:
        if char == "*":
            translated.append("%")
        elif char == "?":
            translated.append("_")
        elif char == "\\":
            translated.append("%")
        else:
            translated.append(char)
    return "".join(translated)


def name_condition(name: Name) -> XmlElement:
    has_wildcard = "*" in name.pattern or "?" in name.pattern
    operation = (Comparison.LIKE
                 if has_wildcard or name.icase else Comparison.EQUAL)
    value = (glob_to_like(name.pattern)
             if operation == Comparison.LIKE else name.pattern)
    return comparison(operation, constants.DISPLAY_NAME, value)


def compile_predicate(node: PredNode) -> CompiledPredicate | None:
    if isinstance(node, TrueNode):
        return CompiledPredicate(None)
    if isinstance(node, Name):
        if "[" in node.pattern:
            return None
        return CompiledPredicate(name_condition(node))
    if isinstance(node, Type):
        if node.kind == FindType.DIRECTORY:
            return CompiledPredicate(is_collection())
        if node.kind == FindType.FILE:
            return CompiledPredicate(not_collection())
        return None
    if isinstance(node, Not):
        compiled = compile_predicate(node.kid)
        if compiled is None or compiled.condition is None:
            return None
        return CompiledPredicate(negate(compiled.condition))
    if isinstance(node, (And, Or)):
        conditions: list[XmlElement] = []
        for kid in node.kids:
            compiled = compile_predicate(kid)
            if compiled is None:
                return None
            if compiled.condition is None:
                if isinstance(node, Or):
                    return None
                continue
            conditions.append(compiled.condition)
        if not conditions:
            return CompiledPredicate(None) if isinstance(node, And) else None
        operation = (BooleanOperation.AND
                     if isinstance(node, And) else BooleanOperation.OR)
        return CompiledPredicate(combine(operation, conditions))
    return None


def size_condition(query: FilesSearchQuery) -> XmlElement | None:
    bounds: list[XmlElement] = []
    if (query.size.lower is not None and query.size.upper == query.size.lower):
        bounds.append(
            comparison(Comparison.EQUAL, constants.SIZE, query.size.lower))
    else:
        if query.size.lower is not None:
            bounds.append(
                comparison(Comparison.GREATER_THAN_OR_EQUAL, constants.SIZE,
                           query.size.lower))
        if query.size.upper is not None:
            bounds.append(
                comparison(Comparison.LESS_THAN_OR_EQUAL, constants.SIZE,
                           query.size.upper))
    if not bounds:
        return None
    file_bounds = combine(BooleanOperation.AND, [not_collection(), *bounds])
    includes_zero = ((query.size.lower is None or query.size.lower <= 0)
                     and (query.size.upper is None or query.size.upper >= 0))
    if includes_zero:
        return combine(BooleanOperation.OR, [is_collection(), file_bounds])
    return file_bounds


def where_condition(query: FilesSearchQuery) -> XmlElement | None:
    compiled = compile_predicate(query.tree)
    if compiled is None:
        return None
    conditions: list[XmlElement] = []
    if compiled.condition is not None:
        conditions.append(compiled.condition)
    size = size_condition(query)
    if size is not None:
        conditions.append(size)
    if query.modified.lower is not None:
        conditions.append(
            comparison(Comparison.GREATER_THAN_OR_EQUAL,
                       constants.LAST_MODIFIED,
                       math.floor(query.modified.lower)))
    if query.modified.upper is not None:
        conditions.append(
            comparison(Comparison.LESS_THAN_OR_EQUAL, constants.LAST_MODIFIED,
                       math.ceil(query.modified.upper)))
    return combine(BooleanOperation.AND, conditions) if conditions else None


def supports_query(query: FilesSearchQuery) -> bool:
    return where_condition(query) is not None


def order(parent: XmlElement, field: Property) -> None:
    element = ElementTree.SubElement(parent, dav("order"))
    property_element(element, field)
    ElementTree.SubElement(element, dav("ascending"))


def request_body(target: SearchTarget, path: PathSpec, query: FilesSearchQuery,
                 offset: int) -> bytes:
    condition = where_condition(query)
    if condition is None:
        raise ValueError("Nextcloud Files Search requires a supported query")
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
    where.append(condition)
    orderby = ElementTree.SubElement(basic, dav("orderby"))
    for field in constants.ORDER_PROPERTIES:
        order(orderby, field)
    limit = ElementTree.SubElement(basic, dav("limit"))
    count = ElementTree.SubElement(limit, dav("nresults"))
    count.text = str(constants.SEARCH_PAGE_SIZE)
    first = ElementTree.SubElement(limit, searchdav("firstresult"))
    first.text = str(offset)
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)
