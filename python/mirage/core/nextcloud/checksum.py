# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import logging
from http import HTTPStatus
from xml.etree import ElementTree

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.constants import CHECKSUM_PROPFIND, CHECKSUM_TYPES
from mirage.core.nextcloud.dav import dav_request, dav_url
from mirage.core.nextcloud.search.response import successful_status
from mirage.core.nextcloud.search.types import Namespace
from mirage.core.nextcloud.search.xml import dav, qname
from mirage.observe.context import record, start_op
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def checksum(
    accessor: NextcloudAccessor,
    path: PathSpec,
    algorithm: str,
) -> str | None:
    """The digest Nextcloud keeps for a file, from ``oc:checksums``.

    A client that uploads with an ``OC-Checksum`` header (the desktop and
    mobile clients do) leaves its digest on the file, and a write without
    one clears it, so a digest the server reports names the bytes it
    holds. The property is one space-separated list of ``TYPE:hex``; only
    the asked algorithm's, in hex of its length, answers. A server that
    keeps none, a collection, and any answer but a 207 leave the file to be
    read and hashed, which reports it. A digest answered is recorded as the
    read it stands in for.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the file.
        algorithm (str): the hashlib name asked for.
    """
    kind = CHECKSUM_TYPES.get(algorithm)
    if kind is None:
        return None
    name, width = kind
    timer = start_op()
    response = await dav_request(
        accessor,
        "PROPFIND",
        dav_url(accessor, path),
        headers={"Depth": "0", "Content-Type": "application/xml"},
        content=CHECKSUM_PROPFIND,
    )
    if response.status_code != HTTPStatus.MULTI_STATUS:
        logger.debug(
            "nextcloud checksum of %s left to the read: HTTP %s",
            path.virtual,
            response.status_code,
        )
        return None
    root = ElementTree.fromstring(response.content)
    listed: list[str] = []
    for propstat in root.iter(dav("propstat")):
        prop = propstat.find(dav("prop"))
        if prop is None or not successful_status(
            propstat.findtext(dav("status"), "")
        ):
            continue
        if prop.find(f"{dav('resourcetype')}/{dav('collection')}") is not None:
            return None
        for item in prop.iter(qname(Namespace.OWNCLOUD, "checksum")):
            listed.extend((item.text or "").split())
    for entry in listed:
        label, _, digest = entry.partition(":")
        digest = digest.lower()
        if (
            label.upper() == name
            and len(digest) == width
            and not digest.strip("0123456789abcdef")
        ):
            record("read", path.virtual, "nextcloud", 0, timer)
            return digest
    return None
