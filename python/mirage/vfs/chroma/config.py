from pydantic import BaseModel, ConfigDict, SecretStr, field_validator


class ChromaConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    host: str = "localhost"
    """Host name of the Chroma HTTP server."""
    port: int = 8000
    """Port of the Chroma HTTP server."""
    ssl: bool = False
    """Connect over HTTPS instead of HTTP."""
    api_key: SecretStr | None = None
    """Chroma API key, sent in the `x-chroma-token` header as Chroma Cloud
    expects. Unset sends no key."""
    collection_name: str
    """Name of the existing Chroma collection to mount."""
    slug_field: str = "page_slug"
    """Chunk metadata key that holds the path of the file a chunk belongs
    to, relative to the mount root (`guides/quickstart.md`)."""
    chunk_index_field: str = "chunk_index"
    """Chunk metadata key whose integer orders a file's chunks; a chunk
    without one sorts as `0`."""

    @field_validator("api_key")
    @classmethod
    def _key_is_set(cls, value: SecretStr | None) -> SecretStr | None:
        """Refuse an empty key, which would reach the server as no key."""
        if value is not None and not value.get_secret_value().strip():
            raise ValueError("Chroma api_key cannot be empty")
        return value

    @field_validator("collection_name", "slug_field", "chunk_index_field")
    @classmethod
    def normalize_non_empty(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("value cannot be empty")
        return normalized
