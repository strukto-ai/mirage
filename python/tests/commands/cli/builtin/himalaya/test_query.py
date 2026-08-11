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

import pytest

from mirage.commands.cli.builtin.himalaya.query import (QueryError, Sorter,
                                                        page_slice,
                                                        parse_query,
                                                        sort_headers,
                                                        uid_budget)


def criteria(source: str) -> str:
    return parse_query(source).criteria


def test_empty_query_matches_everything():
    query = parse_query("")
    assert query.criteria == "ALL"
    assert query.sorters == ()


def test_text_conditions_become_quoted_imap_keys():
    assert criteria("from alice") == 'FROM "alice"'
    assert criteria("to bob") == 'TO "bob"'
    assert criteria("subject invoice") == 'SUBJECT "invoice"'
    assert criteria("body refund") == 'BODY "refund"'


def test_and_is_implicit_juxtaposition_and_or_is_prefix():
    assert criteria("from alice and to bob") == '(FROM "alice" TO "bob")'
    assert criteria("from alice or to bob") == 'OR FROM "alice" TO "bob"'


def test_and_binds_tighter_than_or():
    assert criteria("from a and to b or subject c") == (
        'OR (FROM "a" TO "b") SUBJECT "c"')


def test_parentheses_regroup():
    assert criteria("from a and (to b or subject c)") == (
        '(FROM "a" OR TO "b" SUBJECT "c")')


def test_not_negates_the_next_condition():
    assert criteria("not flag seen") == "NOT SEEN"


def test_flags_map_to_imap_keywords():
    assert criteria("flag answered") == "ANSWERED"
    assert criteria("flag DRAFT") == "DRAFT"


def test_unknown_flag_is_a_query_error():
    with pytest.raises(QueryError, match="unknown flag"):
        parse_query("flag urgent")


def test_date_condition_is_an_exact_day():
    assert criteria("date 2026-02-03") == "SENTON 03-Feb-2026"


def test_before_condition_is_exclusive_like_imap():
    assert criteria("before 2026-02-03") == "SENTBEFORE 03-Feb-2026"


def test_after_is_strictly_greater_so_it_asks_for_the_next_day():
    # IMAP SENTSINCE is inclusive; himalaya's `after` is not.
    assert criteria("after 2026-01-01") == "SENTSINCE 02-Jan-2026"


def test_dates_search_the_header_not_the_received_at_timestamp():
    # ON/BEFORE/SINCE would match the mailbox internal date, which is
    # the wrong day for imported or delayed mail.
    for source in ("date 2026-02-03", "before 2026-02-03", "after 2026-02-03"):
        assert criteria(source).startswith("SENT")


def test_bad_date_is_a_query_error():
    with pytest.raises(QueryError, match="invalid date"):
        parse_query("date 2026-13-40")


def test_quoted_pattern_keeps_spaces_and_defuses_keywords():
    assert criteria('subject "and or not"') == 'SUBJECT "and or not"'


def test_quotes_inside_a_pattern_are_escaped_for_imap():
    assert criteria('subject "say \\"hi\\""') == 'SUBJECT "say \\"hi\\""'


def test_unterminated_quote_is_a_query_error():
    with pytest.raises(QueryError, match="unterminated"):
        parse_query('subject "open')


def test_sorters_parse_with_asc_default():
    query = parse_query("order by subject from desc")
    assert query.criteria == "ALL"
    assert query.sorters == (Sorter("subject", False), Sorter("from", True))


def test_filter_and_sort_combine():
    query = parse_query("from alice order by date desc")
    assert query.criteria == 'FROM "alice"'
    assert query.sorters == (Sorter("date", True), )


def test_order_by_without_a_key_is_a_query_error():
    with pytest.raises(QueryError, match="expected a sort key"):
        parse_query("order by")


def test_trailing_tokens_are_rejected():
    with pytest.raises(QueryError, match="unexpected"):
        parse_query("from alice bogus")


def test_unknown_condition_is_a_query_error():
    with pytest.raises(QueryError, match="expected a condition"):
        parse_query("sender alice")


HEADERS = [
    {
        "uid": "1",
        "subject": "b",
        "date": "Mon, 02 Feb 2026 10:00:00 +0000",
        "from": {
            "email": "z@x"
        },
    },
    {
        "uid": "2",
        "subject": "a",
        "date": "Tue, 03 Feb 2026 10:00:00 +0000",
        "from": {
            "email": "a@x"
        },
    },
]


def test_no_sorters_orders_by_date_descending():
    assert [h["uid"] for h in sort_headers(HEADERS, ())] == ["2", "1"]


def test_first_sorter_is_the_primary_key():
    ordered = sort_headers(HEADERS, (Sorter("subject", False), ))
    assert [h["uid"] for h in ordered] == ["2", "1"]
    ordered = sort_headers(HEADERS, (Sorter("from", True), ))
    assert [h["uid"] for h in ordered] == ["1", "2"]


def test_undated_headers_sort_last_rather_than_raising():
    ordered = sort_headers([{"date": "not a date"}, *HEADERS], ())
    assert ordered[-1] == {"date": "not a date"}


def test_pages_count_from_one():
    items = [1, 2, 3, 4, 5]
    assert page_slice(items, 1, 2) == [1, 2]
    assert page_slice(items, 3, 2) == [5]
    assert page_slice(items, 9, 2) == []


def test_default_order_only_needs_the_pages_asked_for():
    assert uid_budget(1, 25, (), 200) == 25
    assert uid_budget(3, 25, (), 200) == 75


def test_the_account_window_caps_deep_paging():
    assert uid_budget(40, 25, (), 200) == 200


def test_an_explicit_sort_has_to_consider_the_whole_window():
    assert uid_budget(1, 25, (Sorter("subject", False), ), 200) == 200


def test_page_zero_still_costs_one_page():
    assert uid_budget(0, 25, (), 200) == 25
