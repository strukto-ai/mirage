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

from mirage.commands.cli.builtin.himalaya.builder import (Compose, Source,
                                                          build, compose_body,
                                                          has_prefix,
                                                          quote_text,
                                                          reply_recipients,
                                                          split_addresses)

ORIGINAL = {
    "subject": "Quarterly numbers",
    "from": {
        "name": "Alice",
        "email": "alice@example.com"
    },
    "to": [{
        "name": "",
        "email": "me@example.com"
    }],
    "cc": [{
        "name": "Bob",
        "email": "bob@example.com"
    }],
    "message_id": "<m1@example.com>",
    "references": ["<m0@example.com>"],
    "body_text": "line one\nline two",
}


def test_split_addresses_flattens_repeats_and_comma_lists():
    assert split_addresses(["a@x, b@x", " c@x "]) == ("a@x", "b@x", "c@x")


def test_has_prefix_keeps_the_colon():
    assert has_prefix("Re: hello", "Re: ")
    assert has_prefix("re: hello", "Re: ")
    # Without the colon in the comparison this would read as prefixed.
    assert not has_prefix("Ready to ship", "Re: ")


def test_quote_text_prefixes_each_line_once():
    assert quote_text("a\nb", "") == "> a\n> b"


def test_quote_text_does_not_double_space_already_quoted_lines():
    assert quote_text("> a\nb", "") == ">> a\n> b"


def test_quote_headline_is_not_itself_quoted():
    assert quote_text("a", "On Monday, Alice wrote:") == (
        "On Monday, Alice wrote:\n> a")


def test_quote_text_of_an_empty_body_is_empty():
    assert quote_text("   \n  ", "headline") == ""


def test_compose_body_top_posts_by_default():
    assert compose_body("mine", "> theirs", "", "top") == "mine\n\n> theirs"


def test_compose_body_bottom_posts_when_asked():
    assert compose_body("mine", "> theirs", "", "bottom") == "> theirs\n\nmine"


def test_compose_body_drops_the_blank_line_when_the_user_wrote_nothing():
    assert compose_body("", "> theirs", "", "top") == "> theirs"


def test_signature_rides_after_the_standard_delimiter():
    assert compose_body("mine", "", "Sent from mirage",
                        "top") == "mine\n\n-- \nSent from mirage"


def test_reply_recipients_prefer_reply_to_over_from():
    message = {**ORIGINAL, "reply_to": [{"name": "", "email": "list@x"}]}
    assert reply_recipients(message) == ("list@x", )


def test_reply_recipients_fall_back_to_from_with_the_display_name():
    assert reply_recipients(ORIGINAL) == ("Alice <alice@example.com>", )


def test_compose_needs_a_recipient():
    with pytest.raises(ValueError, match="no recipient"):
        build(Compose(sender="me@example.com"))


def test_compose_renders_every_address_header():
    message = build(
        Compose(sender="me@example.com",
                to=("a@x", ),
                cc=("b@x", ),
                bcc=("c@x", ),
                subject="Hi",
                body="yo"))
    assert message["From"] == "me@example.com"
    assert message["To"] == "a@x"
    assert message["Cc"] == "b@x"
    assert message["Bcc"] == "c@x"
    assert message["Subject"] == "Hi"
    assert message.get_content().strip() == "yo"


def test_reply_derives_subject_recipients_and_threading():
    message = build(Compose(sender="me@example.com", body="thanks"),
                    Source(message=ORIGINAL, mode="reply"))
    assert message["Subject"] == "Re: Quarterly numbers"
    assert message["To"] == "Alice <alice@example.com>"
    assert message["In-Reply-To"] == "<m1@example.com>"
    assert message["References"] == "<m0@example.com> <m1@example.com>"
    assert message.get_content() == "thanks\n\n> line one\n> line two\n"


def test_reply_does_not_stack_a_second_re_prefix():
    original = {**ORIGINAL, "subject": "Re: Quarterly numbers"}
    message = build(Compose(sender="me@example.com", body="ok"),
                    Source(message=original, mode="reply"))
    assert message["Subject"] == "Re: Quarterly numbers"


def test_explicit_to_wins_over_the_derived_reply_recipients():
    message = build(Compose(sender="me@example.com", to=("other@x", )),
                    Source(message=ORIGINAL, mode="reply"))
    assert message["To"] == "other@x"


def test_forward_prefixes_fwd_and_carries_references_but_not_in_reply_to():
    message = build(Compose(sender="me@example.com", to=("c@x", )),
                    Source(message=ORIGINAL, mode="forward"))
    assert message["Subject"] == "Fwd: Quarterly numbers"
    assert message["In-Reply-To"] is None
    assert message["References"] == "<m0@example.com> <m1@example.com>"


def test_forward_still_needs_an_explicit_recipient():
    with pytest.raises(ValueError, match="no recipient"):
        build(Compose(sender="me@example.com"),
              Source(message=ORIGINAL, mode="forward"))
