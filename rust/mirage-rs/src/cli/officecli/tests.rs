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
    assert_eq!(date_serial("2024-03-15"), Some(45366.0));
    assert_eq!(date_serial("2024-02-30"), None);
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

/// One officecli command on `name`, holding `bytes`: stdout, stderr, status.
fn office(name: &str, bytes: &[u8], config: serde_json::Value) -> (String, String, i32) {
    let mut host = crate::host::Host::default();
    host.files.insert(name.to_string(), bytes.to_vec());
    let mut config = config;
    config["file"] = serde_json::json!(name);
    config["absolute"] = serde_json::json!(name);
    if config.get("props").is_none() {
        config["props"] = serde_json::json!([]);
    }
    let mut stream = crate::open("officecli", config.to_string().as_bytes()).expect("opens");
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
fn edits_to_documents_and_decks_are_refused() {
    let (_, err, status) = office(
        "memo.docx",
        MEMO,
        serde_json::json!({"command": "set", "path": "/body/p[1]", "props": ["bold=true"]}),
    );
    assert_eq!(
        (err.as_str(), status),
        ("Error: set on .docx is not available yet: /body/p[1]\n", 1)
    );
    let (_, err, status) = office("new.pptx", b"", serde_json::json!({"command": "create"}));
    assert_eq!(
        (err.as_str(), status),
        ("Error: create on .pptx is not available yet\n", 1)
    );
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
