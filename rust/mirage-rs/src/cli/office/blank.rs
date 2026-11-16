// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! The blank workbook, document and deck `create` writes, as OfficeCLI's
//! `BlankDocCreator` builds them: the same parts, theme and settings,
//! stamped with the time they were made.

use crate::request::Request;
use crate::task::Host;

const HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
const PKG: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const MAIN_X: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const MAIN_W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MAIN_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const MAIN_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const VERSION: &str = "1.0.161";

/// The Office theme every blank package carries.
pub(super) fn theme() -> String {
    format!(
        "{HEAD}<a:theme xmlns:a=\"{MAIN_A}\" name=\"Office Theme\"><a:themeElements><a:clrScheme name=\"Office\"><a:dk1><a:sysClr val=\"windowText\" lastClr=\"000000\"/></a:dk1><a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1><a:dk2><a:srgbClr val=\"44546A\"/></a:dk2><a:lt2><a:srgbClr val=\"E7E6E6\"/></a:lt2><a:accent1><a:srgbClr val=\"4472C4\"/></a:accent1><a:accent2><a:srgbClr val=\"ED7D31\"/></a:accent2><a:accent3><a:srgbClr val=\"A5A5A5\"/></a:accent3><a:accent4><a:srgbClr val=\"FFC000\"/></a:accent4><a:accent5><a:srgbClr val=\"5B9BD5\"/></a:accent5><a:accent6><a:srgbClr val=\"70AD47\"/></a:accent6><a:hlink><a:srgbClr val=\"0563C1\"/></a:hlink><a:folHlink><a:srgbClr val=\"954F72\"/></a:folHlink></a:clrScheme><a:fontScheme name=\"Office\"><a:majorFont><a:latin typeface=\"Calibri Light\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:majorFont><a:minorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:minorFont></a:fontScheme><a:fmtScheme name=\"Office\"><a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w=\"6350\" cap=\"flat\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln><a:ln w=\"12700\" cap=\"flat\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln><a:ln w=\"19050\" cap=\"flat\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"
    )
}

/// The time now as OfficeCLI stamps it, `2026-01-02T03:04:05Z`.
pub(super) async fn now(host: &Host) -> String {
    let (_, data) = host.ask(Request::Clock).await;
    let secs = serde_json::from_slice::<(i64, u32)>(&data).map_or(0, |(s, _)| s);
    stamp(secs)
}

/// Seconds since the epoch as an ISO 8601 UTC time to the second.
pub(super) fn stamp(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// The three document property parts OfficeCLI stamps a new package with.
fn doc_props(now: &str) -> Parts {
    vec![
        ("docProps/core.xml", format!("{HEAD}<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:creator>OfficeCLI</dc:creator><dcterms:created xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:created><cp:lastModifiedBy>OfficeCLI</cp:lastModifiedBy><dcterms:modified xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:modified></cp:coreProperties>").into_bytes()),
        ("docProps/app.xml", format!("{HEAD}<ap:Properties xmlns:ap=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><ap:Application>OfficeCLI/{VERSION}</ap:Application></ap:Properties>").into_bytes()),
        ("docProps/custom.xml", format!("{HEAD}<op:Properties xmlns:op=\"http://schemas.openxmlformats.org/officeDocument/2006/custom-properties\" xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"><op:property fmtid=\"{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}\" pid=\"2\" name=\"OfficeCLI.Version\"><vt:lpwstr>{VERSION}</vt:lpwstr></op:property><op:property fmtid=\"{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}\" pid=\"3\" name=\"OfficeCLI.LastModified\"><vt:lpwstr>{now}</vt:lpwstr></op:property></op:Properties>").into_bytes()),
    ]
}

/// The package relationships to `main` and the property parts.
fn root_rels(main: &str) -> Vec<u8> {
    format!("{HEAD}<Relationships xmlns=\"{PKG}\"><Relationship Id=\"rId1\" Type=\"{REL}/officeDocument\" Target=\"{main}\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/><Relationship Id=\"rId3\" Type=\"{REL}/extended-properties\" Target=\"docProps/app.xml\"/><Relationship Id=\"rId4\" Type=\"{REL}/custom-properties\" Target=\"docProps/custom.xml\"/></Relationships>").into_bytes()
}

/// The content types part: `main_type` for `.xml` by default, then each
/// `(part, type)` override and the property parts'.
fn content_types(main_type: &str, overrides: &[(&str, &str)]) -> Vec<u8> {
    let mut out = format!(
        "{HEAD}<Types xmlns=\"{CT}\"><Default Extension=\"xml\" ContentType=\"{main_type}\"/><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
    );
    let props = [
        (
            "/docProps/core.xml",
            "application/vnd.openxmlformats-package.core-properties+xml",
        ),
        (
            "/docProps/app.xml",
            "application/vnd.openxmlformats-officedocument.extended-properties+xml",
        ),
        (
            "/docProps/custom.xml",
            "application/vnd.openxmlformats-officedocument.custom-properties+xml",
        ),
    ];
    for (part, kind) in overrides.iter().chain(props.iter()) {
        out.push_str(&format!(
            "<Override PartName=\"{part}\" ContentType=\"{kind}\"/>"
        ));
    }
    out.push_str("</Types>");
    out.into_bytes()
}

const THEME_TYPE: &str = "application/vnd.openxmlformats-officedocument.theme+xml";

/// The styles part of a blank workbook: one font, the two fills Excel
/// reserves, one border and one cell format.
pub(super) fn workbook_styles() -> String {
    format!(
        "{HEAD}<styleSheet xmlns=\"{MAIN_X}\"><numFmts count=\"0\"/><fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>"
    )
}

/// The parts of a workbook of one empty sheet, Sheet1.
pub(super) fn workbook_parts(now: &str) -> Parts {
    let mut parts = vec![
        ("[Content_Types].xml", content_types(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
            &[
                ("/xl/worksheets/sheet1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"),
                ("/xl/theme/theme1.xml", THEME_TYPE),
                ("/xl/styles.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"),
            ],
        )),
        ("_rels/.rels", root_rels("xl/workbook.xml")),
        ("xl/workbook.xml", format!("{HEAD}<workbook xmlns=\"{MAIN_X}\" xmlns:r=\"{REL}\"><sheets><sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>").into_bytes()),
        ("xl/_rels/workbook.xml.rels", format!("{HEAD}<Relationships xmlns=\"{PKG}\"><Relationship Id=\"rId1\" Type=\"{REL}/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId3\" Type=\"{REL}/theme\" Target=\"theme/theme1.xml\"/><Relationship Id=\"rId2\" Type=\"{REL}/styles\" Target=\"styles.xml\"/></Relationships>").into_bytes()),
        ("xl/worksheets/sheet1.xml", format!("{HEAD}<worksheet xmlns=\"{MAIN_X}\"><sheetData/></worksheet>").into_bytes()),
        ("xl/theme/theme1.xml", theme().into_bytes()),
        ("xl/styles.xml", workbook_styles().into_bytes()),
    ];
    parts.extend(doc_props(now));
    parts
}

/// The namespaces a new Word document's root declares.
const WORD_NAMESPACES: &str = "xmlns:wpc=\"http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas\" xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" xmlns:o=\"urn:schemas-microsoft-com:office:office\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\" xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:wp14=\"http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:w10=\"urn:schemas-microsoft-com:office:word\" xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\" xmlns:w15=\"http://schemas.microsoft.com/office/word/2012/wordml\" xmlns:wpg=\"http://schemas.microsoft.com/office/word/2010/wordprocessingGroup\" xmlns:wpi=\"http://schemas.microsoft.com/office/word/2010/wordprocessingInk\" xmlns:wne=\"http://schemas.microsoft.com/office/word/2006/wordml\" xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\" mc:Ignorable=\"w14 w15 wp14\"";

/// The parts of a Word document with an empty body on A4 with Word's
/// default margins.
pub(super) fn document_parts(now: &str) -> Parts {
    let w = MAIN_W;
    let mut parts = vec![
        ("[Content_Types].xml", content_types(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
            &[
                ("/word/settings.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"),
                ("/word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"),
                ("/word/theme/theme1.xml", THEME_TYPE),
                ("/word/numbering.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"),
            ],
        )),
        ("_rels/.rels", root_rels("word/document.xml")),
        ("word/document.xml", format!("{HEAD}<w:document {WORD_NAMESPACES}><w:body><w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1800\" w:bottom=\"1440\" w:left=\"1800\"/><w:docGrid w:type=\"default\"/></w:sectPr></w:body></w:document>").into_bytes()),
        ("word/_rels/document.xml.rels", format!("{HEAD}<Relationships xmlns=\"{PKG}\"><Relationship Id=\"rId1\" Type=\"{REL}/settings\" Target=\"settings.xml\"/><Relationship Id=\"rId2\" Type=\"{REL}/styles\" Target=\"styles.xml\"/><Relationship Id=\"rId3\" Type=\"{REL}/theme\" Target=\"theme/theme1.xml\"/><Relationship Id=\"rId4\" Type=\"{REL}/numbering\" Target=\"numbering.xml\"/></Relationships>").into_bytes()),
        ("word/settings.xml", format!("{HEAD}<w:settings xmlns:w=\"{w}\"><w:characterSpacingControl w:val=\"doNotCompress\"/><w:compat><w:spaceForUL/><w:balanceSingleByteDoubleByteWidth/><w:doNotLeaveBackslashAlone/><w:ulTrailSpace/><w:doNotExpandShiftReturn/><w:adjustLineHeightInTable/><w:compatSetting w:name=\"compatibilityMode\" w:uri=\"http://schemas.microsoft.com/office/word\" w:val=\"15\"/><w:compatSetting w:name=\"overrideTableStyleFontSizeAndJustification\" w:uri=\"http://schemas.microsoft.com/office/word\" w:val=\"1\"/><w:compatSetting w:name=\"enableOpenTypeFeatures\" w:uri=\"http://schemas.microsoft.com/office/word\" w:val=\"1\"/><w:compatSetting w:name=\"doNotFlipMirrorIndents\" w:uri=\"http://schemas.microsoft.com/office/word\" w:val=\"1\"/><w:compatSetting w:name=\"differentiateMultirowTableHeaders\" w:uri=\"http://schemas.microsoft.com/office/word\" w:val=\"1\"/></w:compat></w:settings>").into_bytes()),
        ("word/styles.xml", format!("{HEAD}<w:styles xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" xmlns:w=\"{w}\" xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\" mc:Ignorable=\"w14\"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\"/><w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults><w:style w:type=\"paragraph\" w:styleId=\"Normal\" w:default=\"true\"><w:name w:val=\"Normal\"/><w:qFormat/><w:pPr><w:spacing w:after=\"0\" w:line=\"259\" w:lineRule=\"auto\"/></w:pPr></w:style></w:styles>").into_bytes()),
        ("word/theme/theme1.xml", theme().into_bytes()),
        ("word/numbering.xml", format!("{HEAD}<w:numbering xmlns:w=\"{w}\"/>").into_bytes()),
    ];
    parts.extend(doc_props(now));
    parts
}

/// A layout placeholder: its shape id, name, type, index and frame.
type Placeholder = (u32, &'static str, &'static str, Option<u32>, [i64; 4]);

/// The parts of a package, by name.
pub(super) type Parts = Vec<(&'static str, Vec<u8>)>;

/// One layout of the blank deck: its type, name and placeholder shapes.
struct Layout {
    kind: &'static str,
    name: &'static str,
    shapes: &'static [Placeholder],
}

const LAYOUTS: [Layout; 5] = [
    Layout {
        kind: "blank",
        name: "Blank",
        shapes: &[],
    },
    Layout {
        kind: "title",
        name: "Title Slide",
        shapes: &[
            (
                2,
                "Title",
                "ctrTitle",
                None,
                [685_800, 2_130_425, 7_772_400, 1_470_025],
            ),
            (
                3,
                "Subtitle",
                "subTitle",
                Some(1),
                [1_371_600, 3_886_200, 6_400_800, 1_752_600],
            ),
        ],
    },
    Layout {
        kind: "objTx",
        name: "Title and Content",
        shapes: &[
            (
                2,
                "Title",
                "title",
                None,
                [838_200, 365_125, 10_515_600, 1_325_563],
            ),
            (
                3,
                "Content",
                "body",
                Some(1),
                [838_200, 1_825_625, 10_515_600, 4_351_338],
            ),
        ],
    },
    Layout {
        kind: "twoColTx",
        name: "Two Content",
        shapes: &[
            (
                2,
                "Title",
                "title",
                None,
                [838_200, 365_125, 10_515_600, 1_325_563],
            ),
            (
                3,
                "Content Left",
                "body",
                Some(1),
                [838_200, 1_825_625, 5_181_600, 4_351_338],
            ),
            (
                4,
                "Content Right",
                "body",
                Some(2),
                [6_172_200, 1_825_625, 5_181_600, 4_351_338],
            ),
        ],
    },
    Layout {
        kind: "titleOnly",
        name: "Title Only",
        shapes: &[(
            2,
            "Title",
            "title",
            None,
            [838_200, 365_125, 10_515_600, 1_325_563],
        )],
    },
];

const EMPTY_TREE: &str =
    "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>";

fn layout_xml(layout: &Layout) -> Vec<u8> {
    let mut shapes = String::new();
    for (id, name, ph, idx, [x, y, cx, cy]) in layout.shapes {
        let idx = idx.map_or(String::new(), |i| format!(" idx=\"{i}\""));
        shapes.push_str(&format!("<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name}\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"{ph}\"{idx}/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\"/></a:p></p:txBody></p:sp>"));
    }
    format!(
        "{HEAD}<p:sldLayout xmlns:a=\"{MAIN_A}\" xmlns:r=\"{REL}\" xmlns:p=\"{MAIN_P}\" type=\"{}\"><p:cSld name=\"{}\"><p:spTree>{EMPTY_TREE}{shapes}</p:spTree></p:cSld></p:sldLayout>",
        layout.kind, layout.name
    )
    .into_bytes()
}

/// The parts of a widescreen deck with no slides, one master and its five
/// layouts.
pub(super) fn deck_parts(now: &str) -> Parts {
    const LAYOUT_NAMES: [&str; 5] = [
        "ppt/slideLayouts/slideLayout1.xml",
        "ppt/slideLayouts/slideLayout2.xml",
        "ppt/slideLayouts/slideLayout3.xml",
        "ppt/slideLayouts/slideLayout4.xml",
        "ppt/slideLayouts/slideLayout5.xml",
    ];
    const LAYOUT_RELS: [&str; 5] = [
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        "ppt/slideLayouts/_rels/slideLayout2.xml.rels",
        "ppt/slideLayouts/_rels/slideLayout3.xml.rels",
        "ppt/slideLayouts/_rels/slideLayout4.xml.rels",
        "ppt/slideLayouts/_rels/slideLayout5.xml.rels",
    ];
    let layout_type =
        "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml";
    let mut overrides = vec![(
        "/ppt/slideMasters/slideMaster1.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
    )];
    let layout_parts = [
        "/ppt/slideLayouts/slideLayout1.xml",
        "/ppt/slideLayouts/slideLayout2.xml",
        "/ppt/slideLayouts/slideLayout3.xml",
        "/ppt/slideLayouts/slideLayout4.xml",
        "/ppt/slideLayouts/slideLayout5.xml",
    ];
    overrides.push((layout_parts[0], layout_type));
    overrides.push(("/ppt/theme/theme1.xml", THEME_TYPE));
    for part in &layout_parts[1..] {
        overrides.push((part, layout_type));
    }
    let ids: String = (1..=5)
        .map(|n| {
            format!(
                "<p:sldLayoutId id=\"{}\" r:id=\"rId{n}\"/>",
                2_147_483_648u64 + n
            )
        })
        .collect();
    let master_rels: String = (1..=5)
        .map(|n| format!("<Relationship Id=\"rId{n}\" Type=\"{REL}/slideLayout\" Target=\"../slideLayouts/slideLayout{n}.xml\"/>"))
        .collect();
    let mut parts = vec![
        ("[Content_Types].xml", content_types(
            "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
            &overrides,
        )),
        ("_rels/.rels", root_rels("ppt/presentation.xml")),
        ("ppt/presentation.xml", format!("{HEAD}<p:presentation xmlns:a=\"{MAIN_A}\" xmlns:r=\"{REL}\" xmlns:p=\"{MAIN_P}\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst/><p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>").into_bytes()),
        ("ppt/_rels/presentation.xml.rels", format!("{HEAD}<Relationships xmlns=\"{PKG}\"><Relationship Id=\"rId1\" Type=\"{REL}/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/><Relationship Id=\"rId2\" Type=\"{REL}/theme\" Target=\"theme/theme1.xml\"/></Relationships>").into_bytes()),
        ("ppt/slideMasters/slideMaster1.xml", format!("{HEAD}<p:sldMaster xmlns:a=\"{MAIN_A}\" xmlns:r=\"{REL}\" xmlns:p=\"{MAIN_P}\"><p:cSld><p:spTree>{EMPTY_TREE}</p:spTree></p:cSld><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/><p:sldLayoutIdLst>{ids}</p:sldLayoutIdLst></p:sldMaster>").into_bytes()),
        ("ppt/slideMasters/_rels/slideMaster1.xml.rels", format!("{HEAD}<Relationships xmlns=\"{PKG}\">{master_rels}<Relationship Id=\"rId6\" Type=\"{REL}/theme\" Target=\"../theme/theme1.xml\"/></Relationships>").into_bytes()),
        ("ppt/theme/theme1.xml", theme().into_bytes()),
    ];
    for (i, layout) in LAYOUTS.iter().enumerate() {
        parts.push((LAYOUT_NAMES[i], layout_xml(layout)));
        parts.push((LAYOUT_RELS[i], format!("{HEAD}<Relationships xmlns=\"{PKG}\"><Relationship Id=\"rId1\" Type=\"{REL}/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/></Relationships>").into_bytes()));
    }
    parts.extend(doc_props(now));
    parts
}
