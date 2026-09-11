from mirage.resource.redis.store import escape_glob


def test_escape_glob_quotes_every_match_metacharacter():
    assert escape_glob("m:[ab]?*\\:") == "m:\\[ab\\]\\?\\*\\\\:"


def test_escape_glob_leaves_plain_text_alone():
    assert escape_glob("mirage:fs:file:/a b+c") == "mirage:fs:file:/a b+c"
