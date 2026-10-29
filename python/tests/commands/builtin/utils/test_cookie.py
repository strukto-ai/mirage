# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

# Every expectation is curl 8.14.1's, measured in debian:stable-slim.

import pytest

from mirage.commands.builtin.utils.cookie import (
    JAR_HEADER,
    CookieJar,
    cookie_value,
    default_path,
    parse_date,
    path_matches,
    same_origin,
)

NOW = 1793237940
HOST = "http://127.0.0.1:8080"


def _jar(engine: bool = True, literal: str | None = None) -> CookieJar:
    return CookieJar(engine, literal, lambda: NOW)


def _lines(jar: CookieJar) -> list[str]:
    return jar.render()[len(JAR_HEADER) :].split("\n")[:-1]


@pytest.mark.parametrize(
    "text,epoch",
    [
        ("Fri, 01 Jan 2027 00:00:00 GMT", 1798761600),
        ("Friday, 01-Jan-27 00:00:00 GMT", 1798761600),
        ("Fri Jan  1 00:00:00 2027", 1798761600),
        ("Fri, 01 Jan 2027 00:00:00 +0100", 1798758000),
        ("Fri, 01 Jan 2027 00:00:00 PST", 1798790400),
        ("01 Jan 2027", 1798761600),
        ("Fri, 1 Jan 2027 1:2:3 GMT", 1798765323),
        ("Thu, 01 Jan 1970 00:00:00 GMT", 0),
        ("Fri, 01 Jan 70 00:00:00 GMT", 3155760000),
        ("Fri, 01 Jan 71 00:00:00 GMT", 31536000),
        ("Fri, 01-Jan-2027 00:00:00 GMT", 1798761600),
        ("Thu, 01-Jan-1970 00:00:00 GMT", 0),
        ("Fri, 01 Jan 2027 00:00:00-0800", 1798790400),
        ("Fri, 01 Jan 2027 00:00:00 +1400", 1798711200),
        ("Fri, 01 Jan 2027 00:00:00 +0060", 1798758000),
        ("Fri, 01 Jan 2027 00:00:00 GMT-0800", 1798761600),
        ("Fri, 01 Jan-0800 2027", 1798790400),
        ("Jan 01 2027 -1200", 1798804800),
    ],
)
def test_parse_date_reads(text, epoch):
    assert parse_date(text) == epoch


@pytest.mark.parametrize(
    "text",
    [
        "2027-01-01 00:00:00",
        "Fri, 32 Jan 2027 00:00:00 GMT",
        "Fri, 01 Jan 2027 25:00:00 GMT",
        "Wed, 31 Dec 1969 23:59:59 GMT",
        "Mon, 01 Jan 1601 00:00:00 GMT",
        "notadate",
        "Fri, 01 Jan 2027 00:00:00 +1401",
        "Fri, 01 Jan 2027 00:00:00 +12",
    ],
)
def test_parse_date_refuses(text):
    assert parse_date(text) is None


def test_default_path_is_the_request_path_up_to_its_last_slash():
    assert [
        default_path(p) for p in ("/x", "/jar/", "/jar", "/jar/a/b", "/a/b/c/")
    ] == ["/", "/jar/", "/", "/jar/a/", "/a/b/c/"]


def test_path_matches_below_and_ignores_a_trailing_slash():
    def covered(cookie: str) -> list[str]:
        paths = ("/jar/a", "/jar/a/x", "/jar/ab", "/jar/", "/Jar/a")
        return [p for p in paths if path_matches(cookie, p)]

    assert covered("/jar/a/") == ["/jar/a", "/jar/a/x"]
    assert covered("/jar/a") == ["/jar/a", "/jar/a/x"]
    assert len(covered("abc")) == 5
    assert len(covered("")) == 5


def test_login_is_written_newest_first_httponly_marked():
    jar = _jar()
    jar.store(
        f"{HOST}/jar/login",
        [
            "session=s3cr3t; Path=/; HttpOnly",
            "theme=dark; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT",
        ],
    )
    assert jar.render() == (
        JAR_HEADER + "127.0.0.1\tFALSE\t/\tFALSE\t1827797940\ttheme\tdark\n"
        "#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\ts3cr3t\n"
    )
    assert jar.header(f"{HOST}/jar/private") == "session=s3cr3t; theme=dark"


def test_an_empty_jar_writes_the_header_alone():
    assert _jar().render() == JAR_HEADER


def test_longer_paths_then_longer_names_then_newer_cookies_go_first():
    jar = _jar()
    jar.store(
        f"{HOST}/jar/x",
        ["b=1; Path=/", "a=1; Path=/", "long=1; Path=/", "p=1; Path=/jar"],
    )
    jar.store(f"{HOST}/jar/x", ["q=1; Path=/jar/x"])
    assert jar.header(f"{HOST}/jar/x") == "q=1; p=1; long=1; a=1; b=1"


def test_a_replaced_cookie_keeps_its_place():
    jar = _jar()
    jar.load(
        "127.0.0.1\tFALSE\t/\tFALSE\t0\taa\t1\n"
        "127.0.0.1\tFALSE\t/\tFALSE\t0\tbb\t1\n"
    )
    jar.store(f"{HOST}/x", ["aa=2; Path=/"])
    assert _lines(jar) == [
        "127.0.0.1\tFALSE\t/\tFALSE\t0\tbb\t1",
        "127.0.0.1\tFALSE\t/\tFALSE\t0\taa\t2",
    ]
    assert jar.header(f"{HOST}/x") == "bb=1; aa=2"


def test_the_default_path_and_the_last_attribute_of_a_name():
    jar = _jar()
    jar.store(
        f"{HOST}/jar/a/b",
        ["p=1", "v=1; Path=/a; Path=/; Max-Age=60; Max-Age=0"],
    )
    assert _lines(jar) == ["127.0.0.1\tFALSE\t/jar/a/\tFALSE\t0\tp\t1"]
    assert jar.header(f"{HOST}/jar/a") == "p=1"
    assert jar.header(f"{HOST}/jar/x") is None


def test_max_age_runs_from_arrival_and_a_lifetime_caps_at_400_days():
    now = 1793238212
    jar = CookieJar(True, None, lambda: now)
    jar.store(
        f"{HOST}/x",
        [
            "m=1; Max-Age=100; Path=/",
            "exact=1; Max-Age=34560000; Path=/",
            "over=1; Max-Age=34560001; Path=/",
            "both=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60; Path=/",
            "lead=1; Max-Age=12abc; Path=/",
        ],
    )
    assert [" ".join(line.split("\t")[4:6]) for line in _lines(jar)] == [
        f"{now + 12} lead",
        f"{now + 60} both",
        "1827798240 over",
        "1827798212 exact",
        f"{now + 100} m",
    ]


def test_an_expired_max_age_or_expires_deletes_and_a_bad_max_age_drops():
    jar = _jar()
    jar.load(
        "127.0.0.1\tFALSE\t/\tFALSE\t0\tgone\t1\n"
        "127.0.0.1\tFALSE\t/\tFALSE\t0\tpast\t1\n"
        "127.0.0.1\tFALSE\t/\tFALSE\t0\tkept\told\n"
    )
    jar.store(
        f"{HOST}/x",
        [
            "gone=; Max-Age=-5; Path=/",
            "past=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
            "kept=1; Max-Age=abc; Path=/",
            "plus=1; Max-Age=+30; Path=/",
            "new=1; Max-Age=0; Path=/",
            "bad=1; Expires=notadate; Path=/",
        ],
    )
    assert _lines(jar) == [
        "127.0.0.1\tFALSE\t/\tFALSE\t0\tbad\t1",
        "127.0.0.1\tFALSE\t/\tFALSE\t0\tkept\told",
    ]


def test_a_max_age_or_file_expiry_of_any_length_is_bounded():
    jar = _jar()
    jar.store(
        f"{HOST}/x",
        [
            f"big=1; Max-Age={'9' * 5000}; Path=/",
            f"neg=1; Max-Age=-{'9' * 5000}; Path=/",
        ],
    )
    jar.load(
        f"127.0.0.1\tFALSE\t/\tFALSE\t{'9' * 23}\thuge\t1\n"
        "127.0.0.1\tFALSE\t/\tFALSE\t9223372036854775808\tover\t1\n"
        "127.0.0.1\tFALSE\t/\tFALSE\t9223372036854775807\tmax\t1\n"
    )
    assert jar.header(f"{HOST}/x") == "max=1; big=1"
    assert next(c for c in jar.cookies if c.name == "big").expires == (
        NOW + 34560000
    )


def test_plain_http_on_a_remote_host_leaves_secure_cookies_alone():
    jar = _jar()
    plain = "http://s.example.com/x"
    jar.load(
        "s.example.com\tFALSE\t/\tTRUE\t0\tsession\tgood\n"
        "s.example.com\tFALSE\t/ab\tTRUE\t0\tdeep\tgood\n"
        ".example.com\tTRUE\t/\tTRUE\t0\twide\tgood\n"
    )
    jar.store(
        plain,
        [
            "session=attacker; Path=/",
            "session=; Max-Age=0; Path=/",
            "session=attacker; Path=/x",
            "deep=a; Path=/a",
            "wide=a; Path=/",
        ],
    )
    assert _lines(jar) == [
        "s.example.com\tFALSE\t/\tFALSE\t0\twide\ta",
        "s.example.com\tFALSE\t/a\tFALSE\t0\tdeep\ta",
        ".example.com\tTRUE\t/\tTRUE\t0\twide\tgood",
        "s.example.com\tFALSE\t/ab\tTRUE\t0\tdeep\tgood",
        "s.example.com\tFALSE\t/\tTRUE\t0\tsession\tgood",
    ]
    jar.store("https://s.example.com/x", ["session=new; Path=/"])
    assert "session=new" in (jar.header("https://s.example.com/") or "")
    local = _jar()
    local.load("127.0.0.1\tFALSE\t/\tTRUE\t0\tsession\tgood\n")
    local.store(f"{HOST}/x", ["session=new; Path=/"])
    assert _lines(local) == ["127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\tnew"]


def test_a_name_and_value_read_the_way_curl_reads_them():
    jar = _jar()
    jar.store(
        f"{HOST}/x",
        [
            "flag",
            "=x; Path=/",
            "e=; Path=/",
            " n = v ; Path=/",
            "eq=a=b; Path=/",
            "tv=a\tb; Path=/",
            "cv=a\x01b; Path=/",
        ],
    )
    assert jar.header(f"{HOST}/x") == "eq=a=b; n=v; e=; =x"


def test_a_domain_is_held_to_the_request_host():
    jar = _jar()
    jar.store(
        "http://sub.example.com:8080/x",
        [
            "dp=1; Domain=example.com; Path=/",
            "dc=1; Domain=com; Path=/",
            "ds=1; Domain=sub.example.com; Path=/",
            "du=1; Domain=EXAMPLE.COM; Path=/",
            "de=1; Domain=; Path=/",
            "dx=1; Domain=xample.com; Path=/",
        ],
    )
    jar.store(
        f"{HOST}/x",
        ["di=1; Domain=.127.0.0.1; Path=/", "d2=1; Domain=0.0.1; Path=/"],
    )
    assert _lines(jar) == [
        "127.0.0.1\tFALSE\t/\tFALSE\t0\tdi\t1",
        "sub.example.com\tFALSE\t/\tFALSE\t0\tde\t1",
        ".EXAMPLE.COM\tTRUE\t/\tFALSE\t0\tdu\t1",
        ".sub.example.com\tTRUE\t/\tFALSE\t0\tds\t1",
        ".example.com\tTRUE\t/\tFALSE\t0\tdp\t1",
    ]
    assert jar.header("http://other.example.com:8080/x") == "du=1; dp=1"


def test_a_secure_cookie_rides_plain_http_only_for_a_local_host():
    jar = _jar()
    jar.store(f"{HOST}/x", ["sec=1; Secure; Path=/"])
    jar.store("http://localhost:8080/x", ["sec=1; Secure; Path=/"])
    jar.store("http://[::1]:8080/x", ["sec=1; Secure; Path=/"])
    jar.store(
        "http://sub.example.com/x",
        ["sec=1; Secure; Path=/", "plain=1; Path=/"],
    )
    assert [line.split("\t")[0] for line in _lines(jar)] == [
        "sub.example.com",
        "::1",
        "localhost",
        "127.0.0.1",
    ]
    jar.load("sub.example.com\tFALSE\t/\tTRUE\t0\tsecf\t1\n")
    assert jar.header("http://sub.example.com/x") == "plain=1"
    assert jar.header("https://sub.example.com/x") == "plain=1; secf=1"
    assert jar.header(f"{HOST}/x") == "sec=1"


def test_the_name_prefixes_hold_to_their_rules_case_and_all():
    jar = _jar()
    jar.store(
        f"{HOST}/x",
        [
            "__Secure-a=1; Path=/",
            "__Secure-b=1; Secure; Path=/",
            "__Host-c=1; Secure; Path=/",
            "__Host-d=1; Secure; Path=/jar",
            "__Host-e=1; Path=/",
            "__secure-x=1; Path=/",
            "__Host-z=1; Secure; Path=/; Domain=127.0.0.1",
        ],
    )
    assert [line.split("\t")[5] for line in _lines(jar)] == [
        "__Host-z",
        "__secure-x",
        "__Host-c",
        "__Secure-b",
    ]


def test_a_cookie_file_loads_and_writes_back():
    jar = _jar()
    jar.load(
        "# comment\n"
        "127.0.0.1\tFALSE\t/\tFALSE\t1\told\t1\n"
        "127.0.0.1\tFALSE\t/\tFALSE\t0\tsess\t1\r\n"
        "#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t0\tho\t1\n"
        "127.0.0.1\tTRUE\t/\tFALSE\t0\tsub\t1\n"
        "example.com\tFALSE\t/\tFALSE\t0\tother\t1\n"
        "bad line\n"
        "127.0.0.1\tfalse\t/\ttrue\t0\tlt\t1\n"
        "127.0.0.1\tFALSE\t/\tFALSE\tabc\tbe\t1\n"
        "127.0.0.1\tFALSE\t/\tFALSE\t 0\tsp\t1\n"
        "127.0.0.1\tFALSE\t/\tFALSE\t0x10\thx\t1\n"
        "127.0.0.1\tFALSE\t/\tFALSE\t0\tnoval\n"
    )
    assert jar.header(f"{HOST}/x") == "noval=; sess=1; sub=1; hx=1; lt=1; ho=1"
    assert _lines(jar) == [
        "127.0.0.1\tFALSE\t/\tFALSE\t0\tnoval\t",
        "127.0.0.1\tFALSE\t/\tFALSE\t0\thx\t1",
        "127.0.0.1\tFALSE\t/\tTRUE\t0\tlt\t1",
        "example.com\tFALSE\t/\tFALSE\t0\tother\t1",
        ".127.0.0.1\tTRUE\t/\tFALSE\t0\tsub\t1",
        "#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t0\tho\t1",
        "127.0.0.1\tFALSE\t/\tFALSE\t0\tsess\t1",
    ]


def test_set_cookie_lines_load_and_a_domainless_one_rides_everywhere_unsaved():
    jar = _jar()
    jar.load(
        "Set-Cookie: sa=1; Path=/\nset-cookie: sb=2\n"
        "Set-Cookie: sc=3; Domain=example.com\n"
    )
    assert jar.header(f"{HOST}/jar/x") == "sa=1; sb=2"
    assert _lines(jar) == [".example.com\tTRUE\t/\tFALSE\t0\tsc\t3"]


def test_literal_data_goes_after_the_jar_and_the_engine_off_keeps_nothing():
    on = _jar(True, "x=1")
    on.store(f"{HOST}/x", ["a=1; Path=/"])
    assert on.header(f"{HOST}/x") == "a=1; x=1"
    off = _jar(False, "a=1;b=2")
    off.store(f"{HOST}/x", ["h=1; Path=/"])
    assert off.header(f"{HOST}/x") == "a=1;b=2"
    assert off.header("http://localhost/y") == "a=1;b=2"
    assert off.cookies == []
    assert _jar(False).header(f"{HOST}/x") is None
    assert off.sent == ["a=1;b=2", "a=1;b=2"]


def test_same_origin_compares_scheme_host_and_port():
    assert same_origin("http://a.test/x", "http://a.test:80/y")
    assert not same_origin("http://a.test/x", "https://a.test/x")
    assert not same_origin("http://a.test/x", "http://b.test/x")
    assert not same_origin("http://a.test:8080/x", "http://a.test/x")
    assert not same_origin("not a url", "http://a.test/")


def test_cookie_value_joins_the_jar_part_and_the_typed_header():
    assert cookie_value("a=1", "x=1") == "a=1; x=1"
    assert cookie_value(None, "x=1") == "x=1"
    assert cookie_value("a=1", None) == "a=1"
    assert cookie_value(None, None) is None
