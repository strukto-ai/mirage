from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PositiveFloat,
    PositiveInt,
    SecretStr,
    field_validator,
)

from mirage.vfs.constants import FULL_SCAN_LIMIT


class DifyConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    api_key: SecretStr
    """Dify Knowledge API key, sent as `Authorization: Bearer`."""
    base_url: str
    """Dify API root, such as `https://api.dify.ai/v1`."""
    dataset_id: str
    """ID of the Knowledge dataset the mount shows."""
    slug_metadata_name: str = "slug"
    """Document metadata field whose value is the document's path in the
    mount. A document without it is mounted under its document name."""
    max_concurrency: PositiveInt = 10
    """The most Dify API requests in flight at once."""
    request_timeout: PositiveFloat = 30.0
    """Seconds to wait for one HTTP request to Dify."""
    retry_attempts: PositiveInt = 4
    """Attempts per request, the first included. A 429, a 5xx or a
    transport error is retried."""
    retry_max_delay: PositiveFloat = 30.0
    """Longest wait in seconds before a retry, whether from backoff or
    `Retry-After`."""
    full_scan_limit: int = Field(default=FULL_SCAN_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""

    @field_validator("base_url")
    @classmethod
    def normalize_base_url(cls, value: str) -> str:
        return value.rstrip("/")

    @field_validator("slug_metadata_name")
    @classmethod
    def normalize_slug_metadata_name(cls, value: str) -> str:
        name = value.strip()
        if not name:
            raise ValueError("slug_metadata_name cannot be empty")
        return name
