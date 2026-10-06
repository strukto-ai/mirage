import pytest

from mirage.workspace.session.functions import function_sources


@pytest.mark.parametrize(
    "value", [None, [], {"f": []}, {"f": 1}, {1: "f() { :; }"}]
)
def test_function_sources_refuses_non_source_records(value):
    with pytest.raises(ValueError, match="shell source strings"):
        function_sources(value)
