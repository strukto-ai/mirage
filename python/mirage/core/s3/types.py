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
