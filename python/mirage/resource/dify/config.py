from pydantic import BaseModel, ConfigDict, field_validator


class DifyConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    api_key: str
    base_url: str
    dataset_id: str
    slug_metadata_name: str = "slug"

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
