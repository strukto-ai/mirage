import hashlib

import pytest

from mirage.commands.builtin.generic.iconv_multibyte import (
    EUC_CN,
    EUC_JP,
    EUC_KR,
    GB18030,
    GBK,
    SJIS,
    MultibyteSpec,
    multibyte_reverse,
    multibyte_table,
)

# Digests of each finished table, which the TypeScript twin asserts too:
# the host decoder only seeds a table, so two hosts agree exactly when
# these do. Every entry was checked against glibc 2.41 on
# debian:stable-slim, both directions.
DIGESTS = [
    (GBK, 21791, "bba66856a1a44bdc", 21920, "4013fbd0c747f579"),
    (EUC_CN, 7445, "e73a16723240a945", 7573, "acabc939aa1cb893"),
    (GB18030, 63360, "995fabe77efceaa4", 63488, "56a3c65aa0c1b946"),
    (EUC_KR, 8227, "f1f8fe46cc836ea0", 8388, "96d8b6b82ea1a6de"),
    (SJIS, 6879, "9e31ef626b7726f0", 7075, "152ab23536e0befb"),
    (EUC_JP, 13009, "0a3c10912de393e1", 13169, "af425d9e826f2b95"),
]


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


@pytest.mark.parametrize("spec,size,digest,rsize,rdigest", DIGESTS)
def test_tables_match_the_pinned_digests(
    spec: MultibyteSpec, size: int, digest: str, rsize: int, rdigest: str
):
    table = multibyte_table(spec)
    reverse = multibyte_reverse(spec)
    text = "".join(f"{k:x}:{v:x}\n" for k, v in sorted(table.items()))
    rtext = "".join(f"{k:x}:{v.hex()}\n" for k, v in sorted(reverse.items()))
    assert (len(table), _digest(text)) == (size, digest)
    assert (len(reverse), _digest(rtext)) == (rsize, rdigest)
