from xml.etree import ElementTree

from mirage.core.nextcloud.search.types import Namespace

ElementTree.register_namespace("d", Namespace.DAV)
ElementTree.register_namespace("oc", Namespace.OWNCLOUD)
ElementTree.register_namespace("sd", Namespace.SEARCHDAV)


def qname(namespace: Namespace, name: str) -> str:
    return f"{{{namespace}}}{name}"


def dav(name: str) -> str:
    return qname(Namespace.DAV, name)


def searchdav(name: str) -> str:
    return qname(Namespace.SEARCHDAV, name)
