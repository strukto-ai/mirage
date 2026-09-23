from pydantic import BaseModel, ConfigDict, field_validator


class ChromaConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    host: str = "localhost"
    port: int = 8000
    ssl: bool = False
    collection_name: str
    slug_field: str = "page_slug"
    chunk_index_field: str = "chunk_index"

    @field_validator("collection_name", "slug_field", "chunk_index_field")
    @classmethod
    def normalize_non_empty(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("value cannot be empty")
        return normalized
