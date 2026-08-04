import pytest

from mirage.core.msgraph._client import id_segment


@pytest.mark.parametrize("value,expected", [
    ("b!abc-_x", "b!abc-_x"),
    ("usr@example.com", "usr%40example.com"),
    ("guest_contoso.com#EXT#@fabrikam.com",
     "guest_contoso.com%23EXT%23%40fabrikam.com"),
    ("contoso.sharepoint.com,site-guid,web-guid",
     "contoso.sharepoint.com%2Csite-guid%2Cweb-guid"),
    ("a b", "a%20b"),
    ("plain/slash", "plain%2Fslash"),
])
def test_id_segment_matches_encodeuricomponent(value, expected):
    """Pin the escaping to what TypeScript's `encodeURIComponent` does.

    The two spellings must agree character for character: ref paths built
    from an escaped id are sent in a JSON body Graph reads literally, so
    escaping `!` on one side only would break copy and rename there.
    """
    assert id_segment(value) == expected


def test_id_segment_escapes_the_guest_upn_fragment():
    # The failure this exists to prevent: `#` interpolated raw starts a
    # URL fragment, so Graph is asked for a truncated path and answers
    # 404 for a user that exists.
    assert "#" not in id_segment("guest_contoso.com#EXT#@fabrikam.com")
