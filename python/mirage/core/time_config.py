from typing import Self

from pydantic import BaseModel, field_validator, model_validator

from mirage.core.time_range import parse_time


class TimeRangeConfig(BaseModel):
    start_time: str | None = None
    """Start of the mount's time scope, inclusive: an RFC 3339 timestamp
    with an explicit timezone and at most millisecond precision. Unset
    leaves the start open."""
    end_time: str | None = None
    """End of the mount's time scope, exclusive, in the same format as
    `start_time`, which it must follow. Unset leaves the end open."""

    @field_validator("start_time", "end_time")
    @classmethod
    def validate_time(cls, value: str | None) -> str | None:
        if value is not None:
            parse_time(value)
        return value

    @model_validator(mode="after")
    def ordered_times(self) -> Self:
        if (
            self.start_time is not None
            and self.end_time is not None
            and parse_time(self.start_time) >= parse_time(self.end_time)
        ):
            raise ValueError("start_time must be earlier than end_time")
        return self
