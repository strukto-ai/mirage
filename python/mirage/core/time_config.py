from typing import Annotated, Self

from pydantic import AfterValidator, BaseModel, model_validator

from mirage.core.time_range import parse_time


def timestamp(value: str) -> str:
    parse_time(value)
    return value


class TimeRangeConfig(BaseModel):
    start_time: Annotated[str, AfterValidator(timestamp)] | None = None
    """Start of the mount's time scope, inclusive: an RFC 3339 timestamp
    with an explicit timezone and at most millisecond precision. Unset
    leaves the start open."""
    end_time: Annotated[str, AfterValidator(timestamp)] | None = None
    """End of the mount's time scope, exclusive, in the same format as
    `start_time`, which it must follow. Unset leaves the end open."""

    @model_validator(mode="after")
    def ordered_times(self) -> Self:
        if (
            self.start_time is not None
            and self.end_time is not None
            and parse_time(self.start_time) >= parse_time(self.end_time)
        ):
            raise ValueError("start_time must be earlier than end_time")
        return self
