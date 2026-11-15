use super::read::{Grid, comments};
use super::sheet::{Edits, Styles, Val, cell_ref, date_serial, notes, rewrite, without_shape};
use super::{Target, number, target};

#[test]
fn paths() {
    assert_eq!(target("/"), Some(Target::Workbook));
    assert_eq!(
        target("/Lists and Notes"),
        Some(Target::Sheet("Lists and Notes".into()))
    );
    assert_eq!(
        target("/Sheet1/B12"),
        Some(Target::Cell("Sheet1".into(), (12, 2)))
    );
    assert_eq!(
        target("Sheet1!F1"),
        Some(Target::Cell("Sheet1".into(), (1, 6)))
    );
    assert_eq!(
        target("'My Sheet'!A1"),
        Some(Target::Cell("My Sheet".into(), (1, 1)))
    );
    assert_eq!(
        target("/考官评分明细/comment[2]"),
        Some(Target::Comment("考官评分明细".into(), 2))
    );
    assert_eq!(
        target("/Sheet1/row[1]"),
        Some(Target::Row("Sheet1".into(), Some(1)))
    );
    assert_eq!(
        target("/Sheet1/A1:B2"),
        Some(Target::Range("Sheet1".into(), (1, 1), (2, 2)))
    );
    assert_eq!(target("/Sheet1/N63/comment"), None);
    assert_eq!(target("/Sheet1/nope"), None);
    assert_eq!(cell_ref("XFD1048576"), Some((1_048_576, 16384)));
    assert_eq!(cell_ref("XFE1"), None);
    assert_eq!(cell_ref("A0"), None);
}

#[test]
fn values() {
    assert_eq!(date_serial("2024-03-15", false), Some(45366.0));
    assert_eq!(date_serial("2024-02-30", false), None);
    assert_eq!(date_serial("1900-01-01", false), Some(1.0));
    assert_eq!(date_serial("1900-02-28", false), Some(59.0));
    assert_eq!(date_serial("1900-03-01", false), Some(61.0));
    assert_eq!(date_serial("2024-03-15", true), Some(43904.0));
    assert_eq!(number("42").as_deref(), Some("42"));
    assert_eq!(number("3.5").as_deref(), Some("3.5"));
    assert_eq!(number("true"), None);
    assert_eq!(number("2024-03-15"), None);
}

const SHEET: &str = r#"<?xml version="1.0"?><x:worksheet xmlns:x="m"><x:dimension ref="A1:B2"/><x:sheetData><x:row r="1"><x:c r="A1" s="3" t="s"><x:v>0</x:v></x:c><x:c r="C1"><x:f>A1</x:f><x:v>1</x:v></x:c></x:row><x:row r="4"/></x:sheetData><x:drawing r:id="rId1"/></x:worksheet>"#;

#[test]
fn rewrite_keeps_every_other_byte() {
    let mut edits = Edits::new();
    edits
        .entry(1)
        .or_default()
        .insert(1, Val::Str("一致".into()));
    edits
        .entry(1)
        .or_default()
        .insert(2, Val::Num("279".into()));
    edits
        .entry(3)
        .or_default()
        .insert(1, Val::Formula("SUM(A1:B1)".into()));
    edits.entry(4).or_default().insert(2, Val::Clear);
    edits
        .entry(9)
        .or_default()
        .insert(1, Val::Str("a<b".into()));
    let out = rewrite(SHEET.as_bytes(), edits, &mut None).unwrap();
    let text = String::from_utf8(out.xml).unwrap();
    assert!(text.contains(r#"<x:c r="A1" s="3" t="str"><x:v>一致</x:v></x:c><x:c r="B1"><x:v>279</x:v></x:c><x:c r="C1"><x:f>A1</x:f><x:v>1</x:v></x:c>"#));
    assert!(
        text.contains(
            r#"<x:row r="3"><x:c r="A3"><x:f>SUM(A1:B1)</x:f></x:c></x:row><x:row r="4"/>"#
        )
    );
    assert!(text.contains(r#"<x:row r="9"><x:c r="A9" t="str"><x:v>a&lt;b</x:v></x:c></x:row></x:sheetData><x:drawing r:id="rId1"/>"#));
    assert!(text.contains(r#"<x:dimension ref="A1:B9"/>"#));
    assert!(!out.formula_replaced);
    let read = Grid::read(text.into_bytes());
    assert_eq!(
        read.rows.iter().map(|r| r.r).collect::<Vec<_>>(),
        vec![1, 3, 4, 9]
    );
}

#[test]
fn overwriting_a_formula_or_a_shared_master() {
    let mut edits = Edits::new();
    edits.entry(1).or_default().insert(3, Val::Num("5".into()));
    assert!(
        rewrite(SHEET.as_bytes(), edits, &mut None)
            .unwrap()
            .formula_replaced
    );
    let shared = r#"<worksheet><sheetData><row r="1"><c r="A1"><f t="shared" ref="A1:A3" si="0">B1</f><v>1</v></c></row></sheetData></worksheet>"#;
    let mut edits = Edits::new();
    edits.entry(1).or_default().insert(1, Val::Num("5".into()));
    assert!(rewrite(shared.as_bytes(), edits, &mut None).is_err());
}

#[test]
fn a_date_takes_the_yyyy_mm_dd_format_once() {
    let xml = r#"<styleSheet xmlns="m"><cellXfs count="2"><xf numFmtId="0" fontId="1"/><xf numFmtId="49" fontId="2"><alignment wrapText="1"/></xf></cellXfs></styleSheet>"#;
    let mut styles = Styles::new(xml.as_bytes().to_vec());
    let s = styles.date_style(1);
    assert_eq!(s, 2);
    assert_eq!(styles.date_style(1), 2);
    let text = String::from_utf8(styles.xml.clone()).unwrap();
    assert!(text.contains(
        r#"<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>"#
    ));
    assert!(text.contains(r#"<cellXfs count="3">"#));
    assert!(text.contains(r#"<xf numFmtId="164" fontId="2" applyNumberFormat="1"><alignment wrapText="1"/></xf></cellXfs>"#));
    assert_eq!(styles.number_format(2), Some((164, "yyyy-mm-dd".into())));
    assert_eq!(styles.number_format(1), Some((49, "@".into())));
}

#[test]
fn comments_and_their_shapes() {
    let xml = r#"<comments><authors><author>统分员</author></authors><commentList><comment ref="N63" authorId="0"><text><r><t>计时器</t></r><r><t>重启</t></r></text></comment><comment ref="N185" authorId="0"><text><t>双签</t></text></comment></commentList></comments>"#;
    let all = notes(xml.as_bytes());
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].cell, "N63");
    let read = comments(xml.as_bytes());
    let node = super::read::comment_node("S", &read[0], 1);
    assert_eq!(
        node.line(),
        r#"/S/comment[1] (comment) "计时器重启" ref=N63 author=统分员 anchoredTo=/S/N63 runs=[{"text":"\u8BA1\u65F6\u5668"},{"text":"\u91CD\u542F"}]"#
    );
    let vml = r#"<xml><v:shape id="a"><x:ClientData><x:Row>62</x:Row><x:Column>13</x:Column></x:ClientData></v:shape><v:shape id="b"><x:ClientData><x:Row>184</x:Row><x:Column>13</x:Column></x:ClientData></v:shape></xml>"#;
    let left = String::from_utf8(without_shape(vml.as_bytes(), (63, 14))).unwrap();
    assert!(!left.contains(r#"id="a""#) && left.contains(r#"id="b""#));
}

const MEMO: &[u8] = include_bytes!("../../../../../integ/fixtures/office/v1/memo.docx");
const DECK: &[u8] = include_bytes!("../../../../../integ/fixtures/office/v1/deck.pptx");

/// One office command on `name`, holding `bytes`: stdout, stderr, status.
fn office(name: &str, bytes: &[u8], config: serde_json::Value) -> (String, String, i32) {
    let mut host = crate::host::Host::default();
    host.files.insert(name.to_string(), bytes.to_vec());
    run(&mut host, name, config)
}

/// One office command on `name` among `host`'s files: stdout, stderr,
/// status.
fn run(
    host: &mut crate::host::Host,
    name: &str,
    config: serde_json::Value,
) -> (String, String, i32) {
    let mut config = config;
    config["file"] = serde_json::json!(name);
    config["absolute"] = serde_json::json!(name);
    if config.get("props").is_none() {
        config["props"] = serde_json::json!([]);
    }
    let mut stream = crate::open("office", config.to_string().as_bytes()).expect("opens");
    let status = host.drive(stream.as_mut());
    (
        String::from_utf8(std::mem::take(&mut host.out)).unwrap(),
        String::from_utf8(std::mem::take(&mut host.err)).unwrap(),
        status,
    )
}

#[test]
fn a_word_run_shows_what_it_inherits() {
    let (out, err, status) = office(
        "memo.docx",
        MEMO,
        serde_json::json!({"command": "get", "path": "/body/p[2]/r[2]"}),
    );
    assert_eq!((err.as_str(), status), ("", 0));
    assert_eq!(
        out,
        "/body/p[2]/r[2] (run) \"twelve percent\" bold=true effective.size=11pt effective.size.src=/docDefaults effective.font.ascii=Calibri effective.font.ascii.src=/docDefaults effective.font.hAnsi=Calibri effective.font.hAnsi.src=/docDefaults\n"
    );
}

#[test]
fn word_queries_match_styles_hyperlinks_and_misses() {
    let (out, _, _) = office(
        "memo.docx",
        MEMO,
        serde_json::json!({"command": "query", "path": "p[style=Heading1]"}),
    );
    assert!(out.starts_with(
        "/body/p[1] (paragraph) \"Quarterly memo\" children=1 style=heading 1 styleId=Heading1 styleName=heading 1 "
    ));
    assert_eq!(out.lines().count(), 1);
    let (out, _, _) = office(
        "memo.docx",
        MEMO,
        serde_json::json!({"command": "query", "path": "hyperlink"}),
    );
    assert_eq!(
        out,
        "/body/p[3]/hyperlink[1] (hyperlink) \"Full report\" url=https://example.com/report\n"
    );
    let (out, err, status) = office(
        "memo.docx",
        MEMO,
        serde_json::json!({"command": "get", "path": "/body/p[9]"}),
    );
    assert_eq!(
        (out.as_str(), err.as_str(), status),
        (
            "",
            "Error: Path not found: /body/p[9]. Available at /body: p[1]..p[4]\n",
            1
        )
    );
}

#[test]
fn a_slide_resolves_placeholders_through_its_layout() {
    let (out, err, status) = office(
        "deck.pptx",
        DECK,
        serde_json::json!({"command": "get", "path": "/slide[1]", "depth": 3}),
    );
    assert_eq!((err.as_str(), status), ("", 0));
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(
        lines[0],
        "/slide[1] (slide) layout=Title Only layoutType=titleOnly"
    );
    assert!(lines[1].starts_with(
        "/slide[1]/shape[@id=2] (title) \"Quarterly review\" name=Title 1 phType=title noGrp=true id=2 isTitle=true effective.x=66pt"
    ));
    assert_eq!(
        lines[3],
        "/slide[1]/shape[@id=2]/paragraph[1]/run[1] (run) \"Quarterly review\" lang=en-US effective.size=44pt effective.size.src=/master[1]/titleStyle/lvl1pPr effective.font.latin=Calibri Light effective.font.latin.src=/theme/majorFont effective.font=Calibri Light effective.font.src=/theme/majorFont"
    );
    assert_eq!(lines.len(), 16);
}

#[test]
fn deck_queries_list_cells_and_refuse_sibling_combinators() {
    let (out, _, _) = office(
        "deck.pptx",
        DECK,
        serde_json::json!({"command": "query", "path": "cell"}),
    );
    assert_eq!(
        out,
        "/slide[1]/table[@id=4]/tr[1]/tc[1] (tc) \"Region\"\n/slide[1]/table[@id=4]/tr[1]/tc[2] (tc) \"Revenue\"\n/slide[1]/table[@id=4]/tr[2]/tc[1] (tc) \"North\"\n/slide[1]/table[@id=4]/tr[2]/tc[2] (tc) \"1250\"\n"
    );
    let (_, err, status) = office(
        "deck.pptx",
        DECK,
        serde_json::json!({"command": "query", "path": "shape + table"}),
    );
    assert_eq!(status, 1);
    assert_eq!(
        err,
        "Error: Unsupported combinator '+' in selector 'shape + table'. `+` (adjacent sibling) and `~` (general sibling) are not supported.\n"
    );
}

#[test]
fn a_created_workbook_document_and_deck_read_back() {
    let mut host = crate::host::Host::default();
    for (name, path, first) in [
        ("n.xlsx", "/", "/Sheet1 (sheet)"),
        ("n.docx", "/body", "/body (body)"),
        (
            "n.pptx",
            "/",
            "/ (presentation) slideWidth=960pt slideHeight=540pt slideSize=widescreen",
        ),
    ] {
        let create = serde_json::json!({"command": "create"});
        let (out, err, status) = run(&mut host, name, create);
        let summary = if name.ends_with(".pptx") {
            "  totalSlides: 0\n  slideWidth: 960pt\n  slideHeight: 540pt\n"
        } else {
            ""
        };
        assert_eq!(
            (out, err, status),
            (format!("Created: {name}\n{summary}"), String::new(), 0)
        );
        let get = serde_json::json!({"command": "get", "path": path});
        let (out, err, status) = run(&mut host, name, get);
        assert_eq!((err.as_str(), status), ("", 0), "{name}");
        assert!(out.contains(first), "{name}: {out}");
    }
}

#[test]
fn a_stamp_is_the_utc_time_to_the_second() {
    assert_eq!(super::blank::stamp(0), "1970-01-01T00:00:00Z");
    assert_eq!(super::blank::stamp(1_795_147_261), "2026-11-20T04:01:01Z");
    assert_eq!(super::blank::stamp(951_782_400), "2000-02-29T00:00:00Z");
}

#[test]
fn a_part_parses_as_the_open_xml_sdk_writes_it() {
    let tree = super::tree::parse(
        br#"<?xml version="1.0"?><w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> a &amp; b </w:t></w:r>"#,
    )
    .ok()
    .unwrap();
    let rpr = tree.root().child(super::tree::W, "rPr").unwrap();
    assert_eq!(
        super::tree::outer_xml(rpr),
        r#"<w:rPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:b /></w:rPr>"#
    );
    assert_eq!(
        tree.root().child(super::tree::W, "t").unwrap().text(),
        " a & b "
    );
    assert!(super::tree::parse(b"<!DOCTYPE x><x/>").is_err());
}

#[test]
fn line_ends_and_attribute_spaces_read_as_xml_reads_them() {
    assert_eq!(super::xml::unescape(b"a\r\nb\rc&#13;d\n"), "a\nb\nc\rd\n");
    assert_eq!(
        super::xml::unescape_attribute(b"a\r\nb\tc&#9;d&#10;"),
        "a b c\td\n"
    );
    let tree = super::tree::parse(
        b"<w:r xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:rPr><w:rStyle w:val=\"a\r\nb\tc\"/></w:rPr><w:t>x\r\ny\rz&#13;<![CDATA[p\r\nq]]></w:t></w:r>",
    )
    .ok()
    .unwrap();
    let style = tree.root().child(super::tree::W, "rPr").unwrap();
    assert_eq!(
        style.child(super::tree::W, "rStyle").unwrap().w("val"),
        Some("a b c")
    );
    assert_eq!(
        tree.root().child(super::tree::W, "t").unwrap().text(),
        "x\ny\nz\rp\nq"
    );
}

#[test]
fn a_date_lands_formatted_where_no_styles_part_was() {
    let rel = r#"<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#;
    let kind = r#"<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>"#;
    let workbook = |date1904: bool| {
        let parts: Vec<(&str, Vec<u8>)> = super::blank::workbook_parts("2026-01-01T00:00:00Z")
            .into_iter()
            .filter(|(name, _)| *name != "xl/styles.xml")
            .map(|(name, data)| {
                let mut text = String::from_utf8(data).unwrap();
                text = text.replace(rel, "").replace(kind, "");
                if date1904 {
                    text = text.replace("<sheets>", r#"<workbookPr date1904="1"/><sheets>"#);
                }
                (name, text.into_bytes())
            })
            .collect();
        super::book::package(&parts)
    };
    for date1904 in [false, true] {
        let mut host = crate::host::Host::default();
        host.files.insert("w.xlsx".to_string(), workbook(date1904));
        let set = serde_json::json!({"command": "set", "path": "/Sheet1/C1", "props": ["value=1900-02-28"]});
        let (out, err, status) = run(&mut host, "w.xlsx", set);
        assert_eq!(
            (out.as_str(), err.as_str(), status),
            ("Updated /Sheet1/C1: value=1900-02-28\n", "", 0)
        );
        let get = serde_json::json!({"command": "get", "path": "/Sheet1/C1"});
        let (out, err, status) = run(&mut host, "w.xlsx", get);
        assert_eq!(
            (out.as_str(), err.as_str(), status),
            (
                "/Sheet1/C1 (cell) \"1900-02-28\" type=Number numFmtId=164 numberformat=yyyy-mm-dd\n",
                "",
                0
            ),
            "date1904={date1904}"
        );
    }
}

#[test]
fn a_styles_part_added_under_prefixed_roots_takes_their_prefix() {
    let rel = r#"<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#;
    let kind = r#"<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>"#;
    let parts: Vec<(&str, Vec<u8>)> = super::blank::workbook_parts("2026-01-01T00:00:00Z")
        .into_iter()
        .filter(|(name, _)| *name != "xl/styles.xml")
        .map(|(name, data)| {
            let text = String::from_utf8(data)
                .unwrap()
                .replace(rel, "")
                .replace(kind, "");
            let text = match name {
                "[Content_Types].xml" => text
                    .replace("<Types xmlns=", "<ct:Types xmlns:ct=")
                    .replace("</Types>", "</ct:Types>")
                    .replace("<Default ", "<ct:Default ")
                    .replace("<Override ", "<ct:Override "),
                "xl/_rels/workbook.xml.rels" => text
                    .replace("<Relationships xmlns=", "<pr:Relationships xmlns:pr=")
                    .replace("</Relationships>", "</pr:Relationships>")
                    .replace("<Relationship ", "<pr:Relationship "),
                _ => text,
            };
            (name, text.into_bytes())
        })
        .collect();
    let mut host = crate::host::Host::default();
    host.files
        .insert("w.xlsx".to_string(), super::book::package(&parts));
    let set =
        serde_json::json!({"command": "set", "path": "/Sheet1/C1", "props": ["value=2024-03-15"]});
    assert_eq!(run(&mut host, "w.xlsx", set).2, 0);
    let get = serde_json::json!({"command": "get", "path": "/Sheet1/C1"});
    let (out, _, status) = run(&mut host, "w.xlsx", get);
    assert_eq!(
        (out.as_str(), status),
        (
            "/Sheet1/C1 (cell) \"2024-03-15\" type=Number numFmtId=164 numberformat=yyyy-mm-dd\n",
            0
        )
    );
    let mut read = |member: &str| {
        let config =
            serde_json::json!({"archive": "w.xlsx", "base": "", "p": true, "members": [member]});
        let mut stream = crate::open("unzip", config.to_string().as_bytes()).expect("opens");
        assert_eq!(host.drive(stream.as_mut()), 0);
        host.err.clear();
        String::from_utf8(std::mem::take(&mut host.out)).unwrap()
    };
    assert!(read("xl/_rels/workbook.xml.rels").contains(r#"<pr:Relationship Id="rId2" "#));
    assert!(read("[[]Content_Types].xml").contains(r#"<ct:Override PartName="/xl/styles.xml" "#));
}

#[test]
fn a_cell_refuses_text_xml_cannot_hold() {
    let set =
        serde_json::json!({"command": "set", "path": "/Sheet1/A2", "props": ["value=p\u{b}q"]});
    let (out, err, status) = office(
        "w.xlsx",
        &super::book::package(&super::blank::workbook_parts("2026-01-01T00:00:00Z")),
        set,
    );
    assert_eq!(
        (out.as_str(), err.as_str(), status),
        (
            "",
            "Error: cell value at A2 contains XML-illegal control character U+000B at position 1. Allowed control chars: \\t, \\n, \\r.\n",
            1
        )
    );
}

#[test]
fn an_empty_format_list_takes_the_date_format() {
    let xml = r#"<styleSheet xmlns="m"><numFmts count="0"/><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>"#;
    let mut styles = Styles::new(xml.as_bytes().to_vec());
    assert_eq!(styles.date_style(0), 1);
    let text = String::from_utf8(styles.xml.clone()).unwrap();
    assert_eq!(text.matches("<numFmts").count(), 1);
    assert!(text.contains(
        r#"<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>"#
    ));
}

#[test]
fn a_utf16_part_parses() {
    let text = "<?xml version=\"1.0\" encoding=\"UTF-16\"?><w:r xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:t>中文</w:t></w:r>";
    let little: Vec<u8> = [0xFF, 0xFE]
        .into_iter()
        .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
        .collect();
    let big: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
    for bytes in [little, big] {
        let tree = super::tree::parse(&bytes).ok().unwrap();
        assert_eq!(
            tree.root().child(super::tree::W, "t").unwrap().text(),
            "中文"
        );
    }
    assert!(super::tree::parse(&[0xFF, 0xFE, b'<']).is_err());
}

#[test]
fn a_word_path_with_wide_characters_reads_without_panicking() {
    let (out, _, status) = office(
        "memo.docx",
        MEMO,
        serde_json::json!({"command": "get", "path": "/body/p[1]/bookmarkStart[@name=中文]"}),
    );
    assert!(status == 0 || out.is_empty(), "{out}");
}

/// One command on `name` among `host`'s files, as `office` runs it: its
/// stdout, stderr and status.
fn cmd(
    host: &mut crate::host::Host,
    name: &str,
    config: serde_json::Value,
) -> (String, String, i32) {
    run(host, name, config)
}

#[test]
fn a_sheet_is_added_renamed_with_its_formulas_and_removed() {
    let mut host = crate::host::Host::default();
    cmd(
        &mut host,
        "b.xlsx",
        serde_json::json!({"command": "create"}),
    );
    let add =
        serde_json::json!({"command": "add", "path": "/", "type": "sheet", "props": ["name=Data"]});
    assert_eq!(cmd(&mut host, "b.xlsx", add).0, "Added sheet at /Data\n");
    let dup =
        serde_json::json!({"command": "add", "path": "/", "type": "sheet", "props": ["name=data"]});
    assert_eq!(
        cmd(&mut host, "b.xlsx", dup),
        (
            String::new(),
            "Error: A sheet named 'Data' already exists. Sheet names must be unique.\n".to_string(),
            1
        )
    );
    let formula = serde_json::json!({"command": "set", "path": "/Sheet1/A1", "props": ["formula=Data!B2&\"Data!\""]});
    assert_eq!(cmd(&mut host, "b.xlsx", formula).2, 0);
    let rename = serde_json::json!({"command": "set", "path": "/Data", "props": ["name=My Data"]});
    assert_eq!(
        cmd(&mut host, "b.xlsx", rename).0,
        "Updated /Data: name=My Data\n"
    );
    let get = serde_json::json!({"command": "get", "path": "/Sheet1/A1"});
    assert!(
        cmd(&mut host, "b.xlsx", get)
            .0
            .contains("formula='My Data'!B2&\"Data!\""),
        "the string literal keeps the old name"
    );
    let remove = serde_json::json!({"command": "remove", "path": "/Sheet1"});
    assert_eq!(cmd(&mut host, "b.xlsx", remove).0, "Removed /Sheet1\n");
    let last = serde_json::json!({"command": "remove", "path": "/My Data"});
    assert_eq!(
        cmd(&mut host, "b.xlsx", last).1,
        "Error: Cannot remove the last sheet. A workbook must contain at least one sheet.\n"
    );
}

#[test]
fn a_document_takes_paragraphs_runs_and_tables() {
    let mut host = crate::host::Host::default();
    cmd(
        &mut host,
        "d.docx",
        serde_json::json!({"command": "create"}),
    );
    let add = |text: &str| serde_json::json!({"command": "add", "path": "/body", "type": "paragraph", "props": [format!("text={text}")]});
    assert_eq!(
        cmd(&mut host, "d.docx", add("Hello")).0,
        "Added paragraph at /body/p[@paraId=00100000]\n"
    );
    let heading = serde_json::json!({"command": "add", "path": "/body", "type": "paragraph", "props": ["text=Title", "style=Heading2"]});
    let (out, err, status) = cmd(&mut host, "d.docx", heading);
    assert_eq!(
        (out.as_str(), err.as_str(), status),
        (
            "Added paragraph at /body/p[@paraId=00100002]\n",
            "  WARNING: style 'Heading2' was not defined in the styles part; added Word's built-in definition ('heading 2')\n",
            0
        )
    );
    let run_add = serde_json::json!({"command": "add", "path": "/body/p[1]", "type": "run", "props": ["text= world", "italic=true"]});
    assert_eq!(
        cmd(&mut host, "d.docx", run_add).0,
        "Added run at /body/p[@paraId=00100000]/r[2]\n"
    );
    let table = serde_json::json!({"command": "add", "path": "/body", "type": "table", "props": ["data=a,b;c,d"]});
    assert_eq!(
        cmd(&mut host, "d.docx", table).0,
        "Added table at /body/tbl[1]\n"
    );
    let shade = serde_json::json!({"command": "set", "path": "/body/tbl[1]/tr[1]/tc[1]", "props": ["shading=FFC000"]});
    assert_eq!(cmd(&mut host, "d.docx", shade).2, 0);
    let get = serde_json::json!({"command": "get", "path": "/body/tbl[1]/tr[1]/tc[1]", "depth": 0});
    assert_eq!(
        cmd(&mut host, "d.docx", get).0,
        "/body/tbl[1]/tr[1]/tc[1] (cell) \"a\" children=1 fill=#FFC000 width=4153dxa\n"
    );
    let unknown = serde_json::json!({"command": "add", "path": "/body", "type": "nope"});
    assert!(
        cmd(&mut host, "d.docx", unknown)
            .1
            .starts_with("Error: Unknown element type 'nope' for /body.")
    );
}

#[test]
fn paragraphs_move_and_swap_by_their_place() {
    let mut host = crate::host::Host::default();
    cmd(
        &mut host,
        "d.docx",
        serde_json::json!({"command": "create"}),
    );
    for text in ["One", "Two", "Three"] {
        let add = serde_json::json!({"command": "add", "path": "/body", "type": "paragraph", "props": [format!("text={text}")]});
        cmd(&mut host, "d.docx", add);
    }
    let mv = serde_json::json!({"command": "move", "path": "/body/p[1]", "index": 2});
    assert_eq!(cmd(&mut host, "d.docx", mv).0, "Moved to /body/p[3]\n");
    let swap = serde_json::json!({"command": "swap", "path": "/body/p[1]", "path2": "/body/p[2]"});
    assert_eq!(
        cmd(&mut host, "d.docx", swap).0,
        "Swapped /body/p[2] <-> /body/p[1]\n"
    );
    let query = serde_json::json!({"command": "query", "path": "paragraph"});
    let out = cmd(&mut host, "d.docx", query).0;
    let order: Vec<&str> = out.lines().filter_map(|l| l.split('"').nth(1)).collect();
    assert_eq!(order, ["Three", "Two", "One"]);
}

#[test]
fn a_deck_takes_slides_text_boxes_and_tables() {
    let mut host = crate::host::Host::default();
    let (out, _, _) = cmd(
        &mut host,
        "s.pptx",
        serde_json::json!({"command": "create"}),
    );
    assert_eq!(
        out,
        "Created: s.pptx\n  totalSlides: 0\n  slideWidth: 960pt\n  slideHeight: 540pt\n"
    );
    let slide = serde_json::json!({"command": "add", "path": "/", "type": "slide", "props": ["layout=title", "title=Hello"]});
    assert_eq!(
        cmd(&mut host, "s.pptx", slide).0,
        "Added slide at /slide[1]\n"
    );
    let tb = serde_json::json!({"command": "add", "path": "/slide[1]", "type": "textbox", "props": ["text=Note", "x=1cm", "y=2cm"]});
    assert_eq!(
        cmd(&mut host, "s.pptx", tb).0,
        "Added textbox at /slide[1]/shape[@id=100000]\n  x: 1cm  y: 2cm  width: 10cm  height: 5cm\n"
    );
    let table = serde_json::json!({"command": "add", "path": "/slide[1]", "type": "table", "props": ["rows=2", "cols=2"]});
    assert_eq!(
        cmd(&mut host, "s.pptx", table).0,
        "Added table at /slide[1]/table[@id=100001]\n  x: 1.27cm  y: 126pt  width: 22.86cm  height: 58.4pt\n"
    );
    let fill = serde_json::json!({"command": "set", "path": "/slide[1]/shape[2]", "props": ["fill=00FF00"]});
    assert_eq!(
        cmd(&mut host, "s.pptx", fill).0,
        "Updated /slide[1]/shape[2]: fill=00FF00 (applied: fill=#00FF00)\n"
    );
    let second =
        serde_json::json!({"command": "add", "path": "/", "type": "slide", "props": ["title=Two"]});
    cmd(&mut host, "s.pptx", second);
    let mv = serde_json::json!({"command": "move", "path": "/slide[2]", "index": 0});
    assert_eq!(cmd(&mut host, "s.pptx", mv).0, "Moved to /slide[1]\n");
    let remove = serde_json::json!({"command": "remove", "path": "/slide[2]"});
    assert_eq!(cmd(&mut host, "s.pptx", remove).0, "Removed /slide[2]\n");
    let query = serde_json::json!({"command": "query", "path": "title"});
    let out = cmd(&mut host, "s.pptx", query).0;
    assert!(
        out.starts_with("/slide[1]/shape[@id=2] (title) \"Two\""),
        "{out}"
    );
    assert_eq!(out.lines().count(), 1);
}

#[test]
fn escapes_in_text_props_resolve() {
    assert_eq!(super::resolve_escapes(r"a\nb\tc\\d\q"), "a\nb\tc\\d\\q");
    let props = super::pairs(&[r"text=x\ny".to_string(), r"style=a\nb".to_string()]);
    assert_eq!(props[0].1, "x\ny");
    assert_eq!(props[1].1, r"a\nb");
}

#[test]
fn a_table_takes_rows_and_widens_for_more_columns() {
    let mut host = crate::host::Host::default();
    cmd(
        &mut host,
        "r.docx",
        serde_json::json!({"command": "create"}),
    );
    let table = serde_json::json!({"command": "add", "path": "/body", "type": "table", "props": ["data=Name,Score;Ann,90"]});
    cmd(&mut host, "r.docx", table);
    let row = serde_json::json!({"command": "add", "path": "/body/tbl[1]", "type": "row", "props": ["c1=Bob", "c2=85"]});
    assert_eq!(
        cmd(&mut host, "r.docx", row).0,
        "Added row at /body/tbl[1]/tr[3]\n"
    );
    let top = serde_json::json!({"command": "add", "path": "/body/tbl[1]", "type": "row", "index": 0, "props": ["c1=Top", "header=true"]});
    assert_eq!(
        cmd(&mut host, "r.docx", top).0,
        "Added row at /body/tbl[1]/tr[1]\n"
    );
    let wide = serde_json::json!({"command": "add", "path": "/body/tbl[1]", "type": "row", "props": ["cols=3", "c3=extra"]});
    assert_eq!(
        cmd(&mut host, "r.docx", wide).0,
        "Added row at /body/tbl[1]/tr[5]\n"
    );
    let get = serde_json::json!({"command": "get", "path": "/body/tbl[1]", "depth": 1});
    let out = cmd(&mut host, "r.docx", get).0;
    assert!(
        out.starts_with("/body/tbl[1] (table) cols=3 rows=5 "),
        "{out}"
    );
    assert!(
        out.contains("/body/tbl[1]/tr[1] (row) children=3 header=true\n"),
        "{out}"
    );
    let refused = serde_json::json!({"command": "add", "path": "/body", "type": "row"});
    assert_eq!(
        cmd(&mut host, "r.docx", refused).1,
        "Error: Cannot add 'row' under /body: rows must be added under a table (/body/tbl[N]).\n"
    );
}

#[test]
fn a_row_takes_cells_and_a_parent_refuses_what_it_cannot_hold() {
    let mut host = crate::host::Host::default();
    cmd(
        &mut host,
        "c.docx",
        serde_json::json!({"command": "create"}),
    );
    let table = serde_json::json!({"command": "add", "path": "/body", "type": "table", "props": ["rows=2", "cols=2"]});
    cmd(&mut host, "c.docx", table);
    let cell = serde_json::json!({"command": "add", "path": "/body/tbl[1]/tr[1]", "type": "cell", "props": ["text=New", "shading=FF0000"]});
    assert_eq!(
        cmd(&mut host, "c.docx", cell).0,
        "Added cell at /body/tbl[1]/tr[1]/tc[3]\n"
    );
    let get = serde_json::json!({"command": "get", "path": "/body/tbl[1]", "depth": 0});
    assert!(
        cmd(&mut host, "c.docx", get).0.contains(" cols=3 rows=2 "),
        "the grid widens and the other row is padded"
    );
    let under_table = serde_json::json!({"command": "add", "path": "/body/tbl[1]", "type": "cell"});
    assert_eq!(
        cmd(&mut host, "c.docx", under_table).1,
        "Error: Cannot add 'cell' under /body/tbl[1]: tables only accept rows (/body/tbl[N]/tr). Use --type row.\n"
    );
    let run_in_body =
        serde_json::json!({"command": "add", "path": "/body", "type": "run", "props": ["text=x"]});
    assert_eq!(
        cmd(&mut host, "c.docx", run_in_body).1,
        "Error: Cannot add 'run' under /body: inline-level elements must live inside a paragraph (/body/p[N]).\n"
    );
}

#[test]
fn breaks_go_in_a_paragraph_or_a_new_one() {
    let mut host = crate::host::Host::default();
    cmd(
        &mut host,
        "k.docx",
        serde_json::json!({"command": "create"}),
    );
    let para = serde_json::json!({"command": "add", "path": "/body", "type": "paragraph", "props": ["text=One"]});
    cmd(&mut host, "k.docx", para);
    let page = serde_json::json!({"command": "add", "path": "/body", "type": "pagebreak"});
    assert_eq!(
        cmd(&mut host, "k.docx", page).0,
        "Added pagebreak at /body/p[@paraId=00100002]\n"
    );
    let line = serde_json::json!({"command": "add", "path": "/body/p[1]", "type": "break", "props": ["type=line"]});
    assert_eq!(
        cmd(&mut host, "k.docx", line).0,
        "Added break at /body/p[@paraId=00100000]/r[2]\n"
    );
    let bogus = serde_json::json!({"command": "add", "path": "/body", "type": "break", "props": ["type=bogus"]});
    assert_eq!(
        cmd(&mut host, "k.docx", bogus).1,
        "Error: Invalid break type: 'bogus'. Valid values: page, column, line, textwrapping.\n"
    );
}

#[test]
fn list_paragraphs_continue_a_list_of_their_kind() {
    let mut host = crate::host::Host::default();
    cmd(
        &mut host,
        "l.docx",
        serde_json::json!({"command": "create"}),
    );
    for (text, style) in [
        ("Apples", "bullet"),
        ("Pears", "bullet"),
        ("Step", "numbered"),
    ] {
        let add = serde_json::json!({"command": "add", "path": "/body", "type": "paragraph", "props": [format!("text={text}"), format!("listStyle={style}")]});
        assert_eq!(cmd(&mut host, "l.docx", add).2, 0);
    }
    let query = serde_json::json!({"command": "query", "path": "paragraph"});
    let out = cmd(&mut host, "l.docx", query).0;
    let ids: Vec<&str> = out
        .lines()
        .filter_map(|l| l.split(" numId=").nth(1))
        .filter_map(|r| r.split(' ').next())
        .collect();
    assert_eq!(ids, ["1", "1", "2"], "{out}");
    let off =
        serde_json::json!({"command": "set", "path": "/body/p[2]", "props": ["listStyle=none"]});
    assert_eq!(
        cmd(&mut host, "l.docx", off).0,
        "Updated /body/p[2]: listStyle=none\n"
    );
}

#[test]
fn a_hyperlink_goes_in_a_paragraph_with_a_relationship() {
    let mut host = crate::host::Host::default();
    cmd(
        &mut host,
        "h.docx",
        serde_json::json!({"command": "create"}),
    );
    let para = serde_json::json!({"command": "add", "path": "/body", "type": "paragraph", "props": ["text=See "]});
    cmd(&mut host, "h.docx", para);
    let link = serde_json::json!({"command": "add", "path": "/body/p[1]", "type": "hyperlink", "props": ["url=https://example.com", "text=example"]});
    assert_eq!(
        cmd(&mut host, "h.docx", link).0,
        "Added hyperlink at /body/p[1]/hyperlink[1]\n"
    );
    let query = serde_json::json!({"command": "query", "path": "hyperlink"});
    assert_eq!(
        cmd(&mut host, "h.docx", query).0,
        "/body/p[@paraId=00100000]/hyperlink[1] (hyperlink) \"example\" url=https://example.com color=hyperlink underline=single\n"
    );
    let bare = serde_json::json!({"command": "add", "path": "/body/p[1]", "type": "hyperlink", "props": ["text=x"]});
    assert_eq!(
        cmd(&mut host, "h.docx", bare).1,
        "Error: 'url' or 'anchor' property is required for hyperlink type\n"
    );
}

#[test]
fn a_slide_table_takes_cell_text_and_rows() {
    let mut host = crate::host::Host::default();
    cmd(
        &mut host,
        "t.pptx",
        serde_json::json!({"command": "create"}),
    );
    cmd(
        &mut host,
        "t.pptx",
        serde_json::json!({"command": "add", "path": "/", "type": "slide"}),
    );
    let table = serde_json::json!({"command": "add", "path": "/slide[1]", "type": "table", "props": ["rows=2", "cols=2"]});
    cmd(&mut host, "t.pptx", table);
    let cell = serde_json::json!({"command": "set", "path": "/slide[1]/table[1]/tr[1]/tc[2]", "props": ["text=Revenue", "bold=true", "fill=FFC000"]});
    assert_eq!(
        cmd(&mut host, "t.pptx", cell).0,
        "Updated /slide[1]/table[1]/tr[1]/tc[2]: text=Revenue, bold=true, fill=FFC000 (applied: bold=true, fill=#FFC000)\n"
    );
    let row = serde_json::json!({"command": "add", "path": "/slide[1]/table[1]", "type": "row"});
    assert_eq!(
        cmd(&mut host, "t.pptx", row).0,
        "Added row at /slide[1]/table[1]/tr[3]\n"
    );
    let missing = serde_json::json!({"command": "set", "path": "/slide[1]/table[1]/tr[4]/tc[1]", "props": ["text=x"]});
    assert_eq!(
        cmd(&mut host, "t.pptx", missing).1,
        "Error: Row 4 not found (table has 3 rows)\n"
    );
    let second = serde_json::json!({"command": "add", "path": "/slide[1]", "type": "table", "props": ["data=a,b"]});
    let (_, err, _) = cmd(&mut host, "t.pptx", second);
    assert_eq!(err, "  WARNING: Same position as Table 1\n");
}

#[test]
fn a_slide_takes_speaker_notes() {
    let mut host = crate::host::Host::default();
    cmd(
        &mut host,
        "n.pptx",
        serde_json::json!({"command": "create"}),
    );
    cmd(
        &mut host,
        "n.pptx",
        serde_json::json!({"command": "add", "path": "/", "type": "slide"}),
    );
    let notes = serde_json::json!({"command": "add", "path": "/slide[1]", "type": "notes", "props": ["text=Say hello"]});
    assert_eq!(
        cmd(&mut host, "n.pptx", notes).0,
        "Added notes at /slide[1]/notes\n"
    );
    let get = serde_json::json!({"command": "get", "path": "/slide[1]/notes"});
    assert_eq!(
        cmd(&mut host, "n.pptx", get).0,
        "/slide[1]/notes (notes) \"Say hello\" text=Say hello lang=en-US\n"
    );
    let remove = serde_json::json!({"command": "remove", "path": "/slide[1]/notes"});
    assert_eq!(
        cmd(&mut host, "n.pptx", remove).0,
        "Removed /slide[1]/notes\n"
    );
    let gone = serde_json::json!({"command": "get", "path": "/slide[1]/notes"});
    assert_eq!(
        cmd(&mut host, "n.pptx", gone).1,
        "Error: Notes not found at /slide[1]/notes (slide has no speaker notes)\n"
    );
}

/// The head of a 40x20 PNG: all a picture reads of it.
const DOT: [u8; 33] = [
    0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n', 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0,
    0, 40, 0, 0, 0, 20, 8, 2, 0, 0, 0, 0, 0, 0, 0,
];

#[test]
fn a_slide_takes_a_picture_framed_at_its_aspect() {
    let mut host = crate::host::Host::default();
    host.files.insert("dot.png".to_string(), DOT.to_vec());
    host.files.insert("fake.jpg".to_string(), DOT.to_vec());
    host.files.insert("note.txt".to_string(), b"hello".to_vec());
    cmd(
        &mut host,
        "p.pptx",
        serde_json::json!({"command": "create"}),
    );
    cmd(
        &mut host,
        "p.pptx",
        serde_json::json!({"command": "add", "path": "/", "type": "slide"}),
    );
    let centered = serde_json::json!({"command": "add", "path": "/slide[1]", "type": "picture", "props": ["src=dot.png"]});
    assert_eq!(
        cmd(&mut host, "p.pptx", centered).0,
        "Added picture at /slide[1]/picture[@id=100000]\n  x: 264pt  y: 162pt  width: 15.24cm  height: 7.62cm\n"
    );
    let tall = serde_json::json!({"command": "add", "path": "/slide[1]", "type": "image", "props": ["path=dot.png", "height=2cm", "alt=Red"]});
    assert_eq!(
        cmd(&mut host, "p.pptx", tall).0,
        "Added image at /slide[1]/picture[@id=100001]\n  x: 5376000emu  y: 3069000emu  width: 4cm  height: 2cm\n"
    );
    let get = serde_json::json!({"command": "get", "path": "/slide[1]/picture[2]"});
    let (out, _, _) = cmd(&mut host, "p.pptx", get);
    assert!(
        out.contains("name=Picture 2 id=100001 alt=Red")
            && out.contains("contentType=image/png fileSize=33"),
        "{out}"
    );
    for (src, error) in [
        ("missing.png", "Error: Image file not found: missing.png\n"),
        (
            "fake.jpg",
            "Error: Image file 'fake.jpg' has extension .jpg but magic bytes indicate PNG. Rename or convert the file.\n",
        ),
        (
            "note.txt",
            "Error: Unsupported image format: .txt. Supported: png, jpg, gif, bmp, tiff, emf, wmf, svg\n",
        ),
    ] {
        let add = serde_json::json!({"command": "add", "path": "/slide[1]", "type": "picture", "props": [format!("src={src}")]});
        assert_eq!(cmd(&mut host, "p.pptx", add).1, error);
    }
    let root = serde_json::json!({"command": "add", "path": "/", "type": "picture", "props": ["src=dot.png"]});
    assert_eq!(
        cmd(&mut host, "p.pptx", root).1,
        "Error: Pictures must be added to a slide: /slide[N]\n"
    );
}

#[test]
fn a_document_takes_inline_and_floating_pictures() {
    let mut host = crate::host::Host::default();
    host.files.insert("dot.png".to_string(), DOT.to_vec());
    cmd(
        &mut host,
        "q.docx",
        serde_json::json!({"command": "create"}),
    );
    cmd(
        &mut host,
        "q.docx",
        serde_json::json!({"command": "add", "path": "/body", "type": "paragraph", "props": ["text=Hello"]}),
    );
    let inline = serde_json::json!({"command": "add", "path": "/body/p[1]", "type": "picture", "props": ["src=dot.png"]});
    assert_eq!(
        cmd(&mut host, "q.docx", inline).0,
        "Added picture at /body/p[@paraId=00100000]/r[2]\n"
    );
    let floating = serde_json::json!({"command": "add", "path": "/body", "type": "picture", "props": ["src=dot.png", "wrap=square", "width=5cm", "alt=Dot"]});
    assert_eq!(
        cmd(&mut host, "q.docx", floating).0,
        "Added picture at /body/p[@paraId=00100002]\n"
    );
    let get = serde_json::json!({"command": "get", "path": "/body", "depth": 2});
    let (out, _, _) = cmd(&mut host, "q.docx", get);
    assert!(
        out.contains("/body/p[@paraId=00100000]/r[2] (picture) \"\" id=1 name=dot.png width=15.2cm height=7.6cm alt="),
        "{out}"
    );
    assert!(
        out.contains("(picture) \"Dot\" id=2 name=Dot width=5.0cm height=2.5cm alt=Dot"),
        "{out}"
    );
    let data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAAAAAAAA";
    let uri = serde_json::json!({"command": "add", "path": "/body", "type": "picture", "props": [format!("src={data}")]});
    assert_eq!(
        cmd(&mut host, "q.docx", uri).0,
        "Added picture at /body/p[@paraId=00100004]\n"
    );
    let get = serde_json::json!({"command": "get", "path": "/body/p[3]/r[1]"});
    assert!(
        cmd(&mut host, "q.docx", get)
            .0
            .contains("name=image width=15.2cm height=7.6cm")
    );
    let bad = serde_json::json!({"command": "add", "path": "/body", "type": "picture", "props": ["src=dot.png", "width=0"]});
    assert_eq!(
        cmd(&mut host, "q.docx", bad).1,
        "Error: Invalid 'width' value: '0'. Picture width must be > 0 (OOXML ST_PositiveCoordinate).\n"
    );
}
