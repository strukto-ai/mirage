import pytest

from mirage.utils.strverscmp import strverscmp


@pytest.mark.parametrize(
    "a,b,sign",
    [
        ("v1.0", "v1.0", 0),
        ("a", "b", -1),
        ("v1.9", "v1.10", -1),
        ("x10", "x9z", 1),
        ("alpha1", "alpha001", 1),
        ("part1_f012", "part1_f01", 1),
        ("foo.009", "foo.0", -1),
        ("a0b", "a00b", 1),
        ("v2.0-rc1", "v2.0", 1),
        ("ISO8859-1//", "ISO88591//", -1),
        ("4.010", "4.9", -1),
        ("4..9", "4.9", -1),
    ],
)
def test_strverscmp_orders_as_glibc_does(a: str, b: str, sign: int):
    result = strverscmp(a, b)
    assert (result > 0) - (result < 0) == sign
