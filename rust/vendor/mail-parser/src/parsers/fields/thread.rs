/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

fn is_re_prefix(prefix: &str) -> bool {
    hashify::tiny_set! {prefix.as_bytes(),
        "re",
        "res",
        "sv",
        "antw",
        "ref",
        "aw",
        "απ",
        "השב",
        "vá",
        "r",
        "rif",
        "bls",
        "odp",
        "ynt",
        "atb",
        "رد",
        "回复",
        "转发",
    }
}

fn is_fwd_prefix(prefix: &str) -> bool {
    hashify::tiny_set! {prefix.as_bytes(),
    "fwd",
    "fw",
    "rv",
    "enc",
    "vs",
    "doorst",
    "vl",
    "tr",
    "wg",
    "πρθ",
    "הועבר",
    "továbbítás",
    "i",
    "fs",
    "trs",
    "vb",
    "pd",
    "i̇lt",
    "yml",
    "إعادة توجيه",
    "回覆",
    "轉寄",
    }
}

pub fn thread_name(text: &str) -> &str {
    let mut token_start = 0;
    let mut token_end = 0;

    let mut thread_name_start = 0;
    let mut fwd_start = 0;
    let mut fwd_end = 0;
    let mut last_blob_end = 0;

    let mut in_blob = false;
    let mut in_blob_ignore = false;
    let mut seen_header = false;
    let mut seen_blob_header = false;
    let mut token_found = false;

    for (pos, ch) in text.char_indices() {
        match ch {
            '[' => {
                if !in_blob {
                    if token_found {
                        if token_end == 0 {
                            token_end = pos;
                        }
                        let prefix = text[token_start..token_end].to_lowercase();
                        if is_re_prefix(prefix.as_ref()) || is_fwd_prefix(prefix.as_ref()) {
                            seen_header = true;
                        } else {
                            break;
                        }
                    }
                    token_found = false;
                    in_blob = true;
                } else {
                    break;
                }
            }
            ']' if in_blob => {
                if seen_blob_header && token_found {
                    fwd_start = token_start;
                    fwd_end = pos;
                }
                if !seen_header {
                    last_blob_end = pos + 1;
                }
                in_blob = false;
                token_found = false;
                seen_blob_header = false;
                in_blob_ignore = false;
            }
            ':' if !in_blob => {
                if (seen_header && token_found) || (!seen_header && !token_found) {
                    break;
                } else if !seen_header {
                    if token_end == 0 {
                        token_end = pos;
                    }
                    let prefix = text[token_start..token_end].to_lowercase();
                    if !is_re_prefix(prefix.as_ref()) && !is_fwd_prefix(prefix.as_ref()) {
                        break;
                    }
                } else {
                    seen_header = false;
                }
                thread_name_start = pos + 1;
                token_found = false;
            }
            ':' if in_blob && !in_blob_ignore => {
                if token_end == 0 {
                    token_end = pos;
                }

                let prefix = text[token_start..token_end].to_lowercase();
                if is_fwd_prefix(prefix.as_ref()) {
                    token_found = false;
                    seen_blob_header = true;
                } else if seen_blob_header && is_re_prefix(prefix.as_ref()) {
                    token_found = false;
                } else {
                    in_blob_ignore = true;
                }
            }
            _ if ch.is_whitespace() => {
                if token_end == 0 {
                    token_end = pos;
                }
            }
            _ => {
                if !token_found {
                    token_start = pos;
                    token_end = 0;
                    token_found = true;
                } else if !in_blob && pos - token_start > 21 {
                    break;
                }
            }
        }
    }

    if last_blob_end > thread_name_start
        || (fwd_start > 0 && last_blob_end > fwd_start && fwd_start > thread_name_start)
    {
        let result = trim_trailing_fwd(&text[last_blob_end..]);
        if !result.is_empty() {
            return result;
        }
    }

    if fwd_start > 0 && thread_name_start < fwd_start {
        let result = trim_trailing_fwd(&text[fwd_start..fwd_end]);
        if !result.is_empty() {
            return result;
        }
    }

    trim_trailing_fwd(&text[thread_name_start..])
}

pub fn trim_trailing_fwd(text: &str) -> &str {
    let mut in_parentheses = false;
    let mut trim_end = true;
    let mut end_found = false;

    let mut text_start = 0;
    let mut text_end = text.len();
    let mut fwd_end = 0;

    for (pos, ch) in text.char_indices().rev() {
        match ch {
            '(' if !end_found => {
                if in_parentheses {
                    in_parentheses = false;
                    if fwd_end - pos > 2
                        && is_fwd_prefix(text[pos + 1..fwd_end].to_lowercase().as_ref())
                    {
                        text_end = pos;
                        trim_end = true;
                        continue;
                    }
                }
                end_found = true;
            }
            ')' if !end_found => {
                if !in_parentheses {
                    in_parentheses = true;
                    fwd_end = pos;
                } else {
                    end_found = true;
                }
            }
            _ if ch.is_whitespace() => {
                if trim_end {
                    text_end = pos;
                }
                continue;
            }
            _ => {
                if !in_parentheses && !end_found {
                    end_found = true;
                }
            }
        }

        if trim_end {
            trim_end = false;
        }
        text_start = pos;
    }

    if text_end >= text_start {
        &text[text_start..text_end]
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use crate::parsers::fields::thread::{thread_name, trim_trailing_fwd};

    #[test]
    fn parse_thread_name() {
        let tests = [
            ("re: hello", "hello"),
            ("re:re: hello", "hello"),
            ("re:fwd: hello", "hello"),
            ("fwd[5]:re[5]: hello", "hello"),
            ("fwd[99]:  re[40]: hello", "hello"),
            (": hello", ": hello"),
            ("z: hello", "z: hello"),
            ("re:: hello", ": hello"),
            ("[10] hello", "hello"),
            ("fwd[a]: hello", "hello"),
            ("re:", ""),
            ("re::", ":"),
            ("", ""),
            (" ", ""),
            ("回复: 轉寄: 轉寄", "轉寄"),
            ("aw[50]: wg: aw[1]: hallo", "hallo"),
            ("res: rv: enc: továbbítás: ", ""),
            ("[fwd: hello world]", "hello world"),
            ("re: enc: re[5]: [fwd: hello world]", "hello world"),
            ("[fwd: re: fw: hello world]", "hello world"),
            ("[fwd: hello world]: another text", ": another text"),
            ("[fwd: re: fwd:] another text", "another text"),
            ("[hello world]", "[hello world]"),
            ("re: fwd[9]: [hello world]", "[hello world]"),
            ("[mailing-list] hello world", "hello world"),
            ("[mailing-list] re: hello world", "hello world"),
            ("[mailing-list] wg[8]:re:  hello world", "hello world"),
            ("hello [world]", "hello [world]"),
            (" [hello] [world] ", "[hello] [world]"),
            ("[mailing-list] hello [world]", "hello [world]"),
            ("[hello [world]", "[hello [world]"),
            ("[]hello [world]", "hello [world]"),
            ("[fwd: re: re:] fwd[6]:re:  fw:", ""),
            ("[fwd hello] world hello", "world hello"),
            ("[fwd: مرحبا بالعالم]", "مرحبا بالعالم"),
            ("[fwd: hello world] مرحبا بالعالم", "مرحبا بالعالم"),
            ("  hello world  ", "hello world"),
            (
                "[mailing-list] wg[8]:re:  hello world (fwd)(fwd)",
                "hello world",
            ),
            ("[fwd: re: fw: hello world (fwd)]", "hello world"),
            (
                "res: rv: enc: továbbítás: hello world (doorst)",
                "hello world",
            ),
            ("[fwd: re: re: (fwd)] fwd[6]:re:  fw: (fwd)", ""),
        ];

        for (input, expected) in tests {
            assert_eq!(thread_name(input), expected, "{input:?}");
        }
    }

    #[test]
    fn parse_trail_fwd() {
        let tests = [
            ("hello (fwd)", "hello"),
            (" hello (fwd)(fwd)", "hello"),
            ("hello (wg) (fwd) (fwd)", "hello"),
            ("(fwd)(fwd)", ""),
            ("(fwd)hello(fwd)", "(fwd)hello"),
            ("  hello  ", "hello"),
            ("  hello world   ", "hello world"),
            ("", ""),
            ("    ", ""),
            ("hello ()(fwd)", "hello ()"),
            ("(hello)", "(hello)"),
            ("hello () (fwd) ()(fwd)", "hello () (fwd) ()"),
            (")(", ")("),
            (" 你好世界(fwd) ", "你好世界"),
            ("你好世界 (回覆)", "你好世界"),
            ("hello(fwd", "hello(fwd"),
            ("hello(fwd))", "hello(fwd))"),
        ];

        for (input, expected) in tests {
            assert_eq!(trim_trailing_fwd(input), expected, "{input:?}");
        }
    }
}
