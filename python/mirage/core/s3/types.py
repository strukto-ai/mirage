from dataclasses import dataclass
from typing import Any

from mirage.vfs.s3.config import S3Config


@dataclass(frozen=True, slots=True)
class S3Conn:
    """One open S3 client plus the config that shaped it.

    Args:
        client (Any): open aioboto3 S3 client.
        config (S3Config): the accessor's config.
    """

    client: Any
    config: S3Config


@dataclass(frozen=True, slots=True)
class CopyReceipt:
    """The copied object's identity, as returned by the store.

    Args:
        fingerprint (str | None): the destination ETag.
        revision (str | None): the exact destination version, when enabled.
        retried (bool): whether an earlier copy attempt may have committed.
    """

    fingerprint: str | None
    revision: str | None
    retried: bool = False
