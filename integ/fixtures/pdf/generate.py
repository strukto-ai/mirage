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

import hashlib
import pathlib

OUT = pathlib.Path(__file__).resolve().parent / "v1"

# The predefined CMaps and character collections a CJK font names, and
# the codec its codes are written in.
CJK = {
    "STSong-Light": ("UniGB-UCS2-H", "GB1", 2, "utf-16-be"),
    "HeiseiMin-W3": ("UniJIS-UCS2-H", "Japan1", 2, "utf-16-be"),
    "HYSMyeongJo-Medium": ("UniKS-UCS2-H", "Korea1", 1, "utf-16-be"),
}

# The 32 bytes the standard security handler pads a password with.
PAD = bytes.fromhex(
    "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a"
)
FILE_ID = bytes.fromhex("6d6972616765706466666978747572e5")


def rc4(key: bytes, data: bytes) -> bytes:
    """The RC4 stream cipher, which 40-bit PDF encryption uses.

    Args:
        key (bytes): the key.
        data (bytes): the bytes to encrypt or decrypt.
    """
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) % 256
        s[i], s[j] = s[j], s[i]
    out = bytearray()
    i = j = 0
    for byte in data:
        i = (i + 1) % 256
        j = (j + s[i]) % 256
        s[i], s[j] = s[j], s[i]
        out.append(byte ^ s[(s[i] + s[j]) % 256])
    return bytes(out)


class Lock:
    """Revision 2 of the standard security handler: an owner password,
    a user password, and the permissions `p` grants.

    Args:
        owner (bytes): the owner password.
        p (int): the permission bits, as a signed 32-bit value.
        user (bytes): the user password; empty opens without one.
    """

    def __init__(self, owner: bytes, p: int, user: bytes = b"") -> None:
        self.p = p
        padded = (user + PAD)[:32]
        self.o = rc4(hashlib.md5((owner + PAD)[:32]).digest()[:5], padded)
        self.key = hashlib.md5(
            padded + self.o + p.to_bytes(4, "little", signed=True) + FILE_ID
        ).digest()[:5]
        self.u = rc4(self.key, PAD)

    def seal(self, number: int, data: bytes) -> bytes:
        """Encrypt one string or stream of object `number`.

        Args:
            number (int): the object's number; its generation is 0.
            data (bytes): the plain bytes.
        """
        object_key = hashlib.md5(
            self.key + number.to_bytes(3, "little") + b"\x00\x00"
        ).digest()[:10]
        return rc4(object_key, data)


def literal(raw: bytes) -> bytes:
    return (
        b"("
        + raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
        + b")"
    )


def text_string(value: str) -> bytes:
    """A document text string: PDFDocEncoding where it fits, else
    UTF-16BE behind its byte order mark."""
    try:
        return value.encode("latin-1")
    except UnicodeEncodeError:
        return b"\xfe\xff" + value.encode("utf-16-be")


def build(spec: dict, lock: Lock | None = None) -> bytes:
    """A PDF from a page list: each page a box and its text runs, each
    run a font, size, position and text; plus the Info entries.

    Args:
        spec (dict): pages, info, version and catalog extras.
        lock (Lock | None): encrypts the file when given.
    """
    objects: list[bytes | None] = []

    def add(body: bytes | None) -> int:
        objects.append(body)
        return len(objects)

    fonts: dict[str, int] = {}

    def font(name: str) -> int:
        if name in fonts:
            return fonts[name]
        if name in CJK:
            cmap, ordering, supplement, _ = CJK[name]
            descendant = add(
                b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /%s "
                b"/CIDSystemInfo << /Registry (Adobe) /Ordering (%s) "
                b"/Supplement %d >> /FontDescriptor << /Type /FontDescriptor "
                b"/FontName /%s /Flags 4 /FontBBox [0 -200 1000 900] "
                b"/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 "
                b"/StemV 80 >> /DW 1000 /W [1 [500]] >>"
                % (name.encode(), ordering.encode(), supplement, name.encode())
            )
            ref = add(
                b"<< /Type /Font /Subtype /Type0 /BaseFont /%s-%s "
                b"/Encoding /%s /DescendantFonts [%d 0 R] >>"
                % (name.encode(), cmap.encode(), cmap.encode(), descendant)
            )
        else:
            ref = add(
                b"<< /Type /Font /Subtype /Type1 /BaseFont /%s "
                b"/Encoding /WinAnsiEncoding >>" % name.encode()
            )
        fonts[name] = ref
        return ref

    pages_ref = add(None)
    kids = []
    for page in spec["pages"]:
        used: dict[bytes, int] = {}
        content = b""
        for shape in page.get("rects", []):
            content += b"0.8 g %s re f\n" % b" ".join(
                str(v).encode() for v in shape
            )
        for run in page.get("text", []):
            name = run.get("font", "Helvetica")
            ref = font(name)
            key = b"F%d" % ref
            used[key] = ref
            if name in CJK:
                body = b"<%s>" % run["text"].encode(CJK[name][3]).hex().upper().encode()
            else:
                body = literal(run["text"].encode("cp1252"))
            content += b"BT /%s %s Tf 1 0 0 1 %s %s Tm %s Tj ET\n" % (
                key,
                str(run.get("size", 12)).encode(),
                str(run["x"]).encode(),
                str(run["y"]).encode(),
                body,
            )
        number = len(objects) + 1
        data = lock.seal(number, content) if lock else content
        stream = add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"\nendstream")
        box = b" ".join(str(v).encode() for v in page.get("box", [0, 0, 612, 792]))
        extra = b" /Rotate %d" % page["rotate"] if "rotate" in page else b""
        fonts_dict = b" ".join(b"/%s %d 0 R" % kv for kv in sorted(used.items()))
        kids.append(
            add(
                b"<< /Type /Page /Parent %d 0 R /MediaBox [%s]%s "
                b"/Resources << /Font << %s >> >> /Contents %d 0 R >>"
                % (pages_ref, box, extra, fonts_dict, stream)
            )
        )
    objects[pages_ref - 1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % k for k in kids),
        len(kids),
    )
    catalog = add(
        b"<< /Type /Catalog /Pages %d 0 R%s >>"
        % (pages_ref, spec.get("catalog", "").encode())
    )
    info_ref = None
    if spec.get("info"):
        number = len(objects) + 1
        entries = []
        for key, value in spec["info"].items():
            raw = text_string(value)
            if lock:
                raw = lock.seal(number, raw)
            entries.append(b"/%s %s" % (key.encode(), literal(raw)))
        info_ref = add(b"<< " + b" ".join(entries) + b" >>")
    encrypt_ref = None
    if lock:
        encrypt_ref = add(
            b"<< /Filter /Standard /V 1 /R 2 /Length 40 /P %d /O <%s> /U <%s> >>"
            % (lock.p, lock.o.hex().encode(), lock.u.hex().encode())
        )
    out = b"%PDF-" + spec.get("version", "1.4").encode() + b"\n%\xe2\xe3\xcf\xd3\n"
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + (body or b"null") + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root %d 0 R" % (len(objects) + 1, catalog)
    if info_ref:
        out += b" /Info %d 0 R" % info_ref
    if encrypt_ref:
        out += b" /Encrypt %d 0 R /ID [<%s> <%s>]" % (
            encrypt_ref,
            FILE_ID.hex().encode(),
            FILE_ID.hex().encode(),
        )
    out += b" >>\nstartxref\n%d\n%%%%EOF\n" % xref
    return out


def lines(x: float, y: float, texts: list[str], size: float = 12, lead: float = 14) -> list[dict]:
    return [
        {"x": x, "y": y - i * lead, "text": text, "size": size}
        for i, text in enumerate(texts)
    ]


REPORT = {
    "version": "1.5",
    "info": {
        "Title": "Quarterly Operations Report",
        "Subject": "Q3 review",
        "Keywords": "operations, quarterly",
        "Author": "Ops Team",
        "Creator": "mirage fixtures",
        "Producer": "generate.py",
        "CreationDate": "D:20240315120000+08'00'",
        "ModDate": "D:20240401093000Z",
    },
    "pages": [
        {
            "text": [{"x": 72, "y": 720, "text": "Quarterly Operations Report", "size": 18}]
            + lines(
                72,
                690,
                [
                    "Revenue grew 12 percent over the second quarter, led by",
                    "renewals in the enterprise segment and a steady rise in",
                    "self-serve sign-ups. Support costs fell as the new routing",
                    "tool cut handoffs between teams.",
                ],
            )
            + lines(72, 600, ["The board approved the hiring plan for the fourth quar-", "ter and the budget for two new regions."]),
        },
        {
            "text": [{"x": 72, "y": 720, "text": "Regional results", "size": 14}]
            + lines(72, 690, ["North region", "Sales rose in every", "month of the quarter."])
            + lines(320, 690, ["South region", "Sales held flat while", "margins improved."]),
        },
        {
            "text": lines(72, 720, ["Metric", "Revenue", "Churn", "Tickets"])
            + lines(200, 720, ["Value", "4.2M", "1.8%", "1,204"]),
        },
    ],
}

CJK_DOC = {
    "version": "1.6",
    "info": {"Title": "年度报告", "Author": "财务部"},
    "pages": [
        {
            "box": [0, 0, 595.276, 841.89],
            "text": [
                {"x": 72, "y": 760, "text": "中兴通讯年度报告", "font": "STSong-Light", "size": 16},
                {"x": 72, "y": 730, "text": "收入增长百分之十二。", "font": "STSong-Light"},
                {"x": 72, "y": 710, "text": "日本語のテキスト", "font": "HeiseiMin-W3"},
                {"x": 72, "y": 690, "text": "한국어 텍스트", "font": "HYSMyeongJo-Medium"},
            ],
        }
    ],
}

SCAN = {
    "info": {"Title": "Scanned receipt", "Producer": "scanner"},
    "pages": [{"rects": [[72, 400, 468, 300]]}],
}

LOCKED = {
    "info": {"Title": "Locked memo", "Author": "Legal"},
    "pages": [{"text": lines(72, 720, ["This memo may be read but not copied."])}],
}

BANDS = {
    "info": {"Title": "Salary bands", "Author": "People"},
    "pages": [{"text": lines(72, 720, ["Only the password opens this page."])}],
}

FAR = {
    "info": {"Title": "Stray glyph"},
    "pages": [{"text": [{"x": 72, "y": 720, "text": "Left"}, {"x": 10**15, "y": 720, "text": "x"}]}],
}


def main() -> None:
    OUT.mkdir(exist_ok=True)
    (OUT / "report.pdf").write_bytes(build(REPORT))
    (OUT / "cjk.pdf").write_bytes(build(CJK_DOC))
    (OUT / "scan.pdf").write_bytes(build(SCAN))
    (OUT / "locked.pdf").write_bytes(build(LOCKED, Lock(b"owner", -3900)))
    (OUT / "secret.pdf").write_bytes(
        build(BANDS, Lock(b"keeper", -4, b"reader"))
    )
    (OUT / "notes.pdf").write_bytes(b"These are plain notes, not a PDF.\n")
    (OUT / "far.pdf").write_bytes(build(FAR))


if __name__ == "__main__":
    main()
