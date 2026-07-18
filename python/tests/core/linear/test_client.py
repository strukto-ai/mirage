from mirage.core.linear._client import LinearAPIError


def test_linear_api_error_preserves_explicit_empty_error_list():
    errors: list[dict] = []
    exc = LinearAPIError("failed", errors=errors)

    assert exc.errors is errors
