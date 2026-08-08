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

import base64
import json
from email.policy import SMTP
from pathlib import Path

import pytest

from mirage.commands.cli.builtin.himalaya.builder import (  # yapf: disable
    Attachment, Compose, Source, build, compose_body, has_prefix,
    mixed_boundary, quote_text, reply_recipients, split_addresses)

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
    assert quote_text(
        "a", "On Monday, Alice wrote:") == ("On Monday, Alice wrote:\n> a")


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


def test_mixed_boundary_is_deterministic_and_content_addressed():
    attachments = (Attachment("a.txt", "text/plain", b"data"), )
    first = mixed_boundary("body", attachments)
    assert first == mixed_boundary("body", attachments)
    assert first != mixed_boundary("other body", attachments)
    assert len(first) == 32


ATTACHMENTS = (Attachment("note.txt", "text/plain", b"the note\n"),
               Attachment("blob.bin", "application/octet-stream", b"\x00\x01"))


def test_attachments_promote_the_message_to_multipart_mixed():
    message = build(
        Compose(sender="me@example.com",
                to=("a@x", ),
                subject="files",
                body="see attached",
                attachments=ATTACHMENTS))
    assert message.get_content_type() == "multipart/mixed"
    assert message.get_boundary() == mixed_boundary("see attached",
                                                    ATTACHMENTS)
    parts = list(message.iter_parts())
    assert parts[0].get_content() == "see attached\n"
    assert parts[1].get_filename() == "note.txt"
    # text/* parts decode to str under the content manager; binary
    # parts stay bytes.
    assert parts[1].get_content() == "the note\n"
    assert parts[2].get_filename() == "blob.bin"
    assert parts[2].get_content() == b"\x00\x01"


def test_a_message_without_attachments_stays_single_part():
    message = build(
        Compose(sender="me@example.com", to=("a@x", ), body="plain"))
    assert message.get_content_type() == "text/plain"


def load_parity_cases() -> list[tuple[str, dict]]:
    """The shared serialization pins both implementations assert against.

    The fixture was generated from this very builder
    (``build(...).as_bytes(policy=SMTP)``), so on the python side the
    test guards against drift away from the pinned bytes; the twin
    TypeScript test (``mime_parity.test.ts``) proves the two builders
    serialize identically.
    """
    root = Path(__file__).parents[6]
    fixture = root / "integ" / "fixtures" / "himalaya" / "mime_parity.json"
    data = json.loads(fixture.read_text())
    return sorted(data.items())


def parity_compose(entry: dict) -> Compose:
    attachments = tuple(
        Attachment(filename=a["filename"],
                   content_type=a["contentType"],
                   data=base64.b64decode(a["dataB64"]))
        for a in entry["attachments"])
    return Compose(sender=entry["sender"],
                   to=tuple(entry["to"]),
                   cc=tuple(entry["cc"]),
                   bcc=tuple(entry["bcc"]),
                   subject=entry["subject"],
                   body=entry["body"],
                   signature=entry["signature"],
                   attachments=attachments)


def parity_source(entry: dict) -> Source | None:
    if "source" not in entry:
        return None
    return Source(message=entry["source"],
                  mode=entry["mode"],
                  posting_style=entry["postingStyle"],
                  quote_headline=entry["quoteHeadline"])


@pytest.mark.parametrize("name,case", load_parity_cases())
def test_serialization_matches_the_shared_parity_pins(name, case):
    compose = parity_compose(case["compose"])
    raw = build(compose, parity_source(case["compose"])).as_bytes(policy=SMTP)
    assert raw == base64.b64decode(case["bytesB64"])


@pytest.mark.parametrize("bad", [
    "evil\nname.txt", "evil\rname.txt", "tail\n", "evil\vname.txt",
    "evil\fname.txt", "evil\x1cname.txt", "evil\x1dname.txt",
    "evil\x1ename.txt"
])
def test_ascii_filename_with_a_line_break_is_refused(bad):
    # EmailMessage refuses the quoted-string form outright (header
    # injection); trailing terminators are refused too, unlike the
    # header-value guard. The TypeScript serializer mirrors this.
    compose = Compose(sender="a@example.com",
                      to=("b@example.com", ),
                      body="hi",
                      attachments=(Attachment(filename=bad,
                                              content_type="text/plain",
                                              data=b"x"), ))
    with pytest.raises(ValueError,
                       match="may not contain linefeed or carriage return"):
        build(compose).as_bytes(policy=SMTP)


def test_nonascii_filename_percent_encodes_line_breaks():
    # The RFC 2231 path never refuses: percent-encoding neutralizes the
    # same characters the quoted-string form cannot carry.
    compose = Compose(sender="a@example.com",
                      to=("b@example.com", ),
                      body="hi",
                      attachments=(Attachment(filename="naïve\nname.txt",
                                              content_type="text/plain",
                                              data=b"x"), ))
    raw = build(compose).as_bytes(policy=SMTP)
    assert b"filename*=utf-8''na%C3%AFve%0Aname.txt" in raw
