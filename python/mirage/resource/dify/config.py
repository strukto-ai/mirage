from pydantic import (BaseModel, ConfigDict, PositiveFloat, PositiveInt,
                      field_validator)


class DifyConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    api_key: str
    base_url: str
    dataset_id: str
    slug_metadata_name: str = "slug"
    max_concurrency: PositiveInt = 10
    request_timeout: PositiveFloat = 30.0
    retry_attempts: PositiveInt = 4
    retry_max_delay: PositiveFloat = 30.0

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
