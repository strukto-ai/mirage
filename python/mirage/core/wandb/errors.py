from mirage.core.api.errors import ApiError


class WandbAPIError(ApiError):
    """A W&B call that failed."""
