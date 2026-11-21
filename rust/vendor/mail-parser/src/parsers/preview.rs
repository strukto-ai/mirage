/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::borrow::Cow;

use crate::decoders::html::html_to_text;

pub fn preview_html<'x>(html: Cow<'_, str>, max_len: usize) -> Cow<'x, str> {
    preview_text(html_to_text(html.as_ref()).into(), max_len)
}

pub fn preview_text<'x>(text: Cow<'_, str>, mut max_len: usize) -> Cow<'x, str> {
    if text.len() > max_len {
        let add_dots = max_len > 6;
        if add_dots {
            max_len -= 3;
        }
        let mut result = String::with_capacity(max_len);
        for ch in text.chars() {
            if ch.len_utf8() + result.len() > max_len {
                break;
            }
            result.push(ch);
        }
        if add_dots {
            result.push_str("...");
        }
        result.into()
    } else {
        text.into_owned().into()
    }
}

pub fn truncate_text<'x>(text: Cow<'_, str>, max_len: usize) -> Cow<'x, str> {
    preview_text(text, max_len)
}

pub fn truncate_html<'x>(html: Cow<'_, str>, mut max_len: usize) -> Cow<'x, str> {
    if html.len() > max_len {
        let add_dots = max_len > 6;
        if add_dots {
            max_len -= 3;
        }

        let mut result = String::with_capacity(max_len);
        let mut in_tag = false;
        let mut in_comment = false;
        let mut last_tag_end_pos = 0;
        for (pos, ch) in html.char_indices() {
            let mut set_last_tag = 0;
            match ch {
                '<' if !in_tag => {
                    in_tag = true;
                    if let Some("!--") = html.get(pos + 1..pos + 4) {
                        in_comment = true;
                    }
                    set_last_tag = pos;
                }
                '>' if in_tag => {
                    if in_comment {
                        if let Some("--") = html.get(pos - 2..pos) {
                            in_comment = false;
                            in_tag = false;
                            set_last_tag = pos + 1;
                        }
                    } else {
                        in_tag = false;
                        set_last_tag = pos + 1;
                    }
                }
                _ => (),
            }
            if ch.len_utf8() + pos > max_len {
                result.push_str(
                    &html[0..if (in_tag || set_last_tag > 0) && last_tag_end_pos > 0 {
                        last_tag_end_pos
                    } else {
                        pos
                    }],
                );
                if add_dots {
                    result.push_str("...");
                }
                break;
            } else if set_last_tag > 0 {
                last_tag_end_pos = set_last_tag;
            }
        }
        result.into()
    } else {
        html.into_owned().into()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn text_preview() {
        let text_1 = concat!(
            "J'interdis aux marchands de vanter trop leurs marchandises. ",
            "Car ils se fontvite pédagogues et t'enseignent comme but ce qui ",
            "n'est par essence qu'un moyen, et te trompant ainsi sur la route ",
            "à suivre les voilà bientôt qui te dégradent, car si leur musique ",
            "est vulgaire ils te fabriquent pour te la vendre une âme vulgaire.\n",
            "— Antoine de Saint-Exupéry, Citadelle (1948)"
        );
        let text_2 = concat!(
            "長沮、桀溺耦而耕，孔子過之，使子路問津焉。長沮曰：「夫執輿者為誰？」",
            "子路曰：「為孔丘。」曰：「是魯孔丘與？」曰：「是也。」曰：「是知津矣。」問於桀溺，",
            "桀溺曰：「子為誰？」曰：「為仲由。」曰：「是魯孔丘之徒與？」對曰：「然。",
            "」曰：「滔滔者天下皆是也，而誰以易之？且而與其從辟人之士也，豈若從",
            "辟世之士哉？」耰而不輟。子路行以告。夫子憮然曰：「鳥獸不可與同群，吾非斯人之徒",
            "與而誰與？天下有道，丘不與易也。」",
            "子路從而後，遇丈人，以杖荷蓧。子路問曰：「子見夫子乎？」丈人曰：「四體不勤，",
            "五穀不分。孰為夫子？」植其杖而芸。子路拱而立。止子路宿，殺雞為黍而食之，見其二",
            "子焉。明日，子路行以告。子曰：「隱者也。」使子路反見之。至則行矣。子路曰：「",
            "不仕無義。長幼之節，不可廢也；君臣之義，如之何其廢之？欲潔其身，而亂大倫。君",
            "子之仕也，行其義也。道之不行，已知之矣。」"
        );

        assert_eq!(
            super::truncate_text(text_1.into(), 110),
            "J'interdis aux marchands de vanter trop leurs marchandises. Car ils se fontvite pédagogues et t'enseignent..."
        );

        assert_eq!(
            super::truncate_text(text_2.into(), 110),
            "長沮、桀溺耦而耕，孔子過之，使子路問津焉。長沮曰：「夫執輿者為誰？」子..."
        );
    }

    #[test]
    fn html_truncate() {
        for (html, expected_result) in [
            (
                "<html>hello<br/>world<br/></html>",
                "<html>hello<br/>world...",
            ),
            ("<html>using &lt;><br/></html>", "<html>using &lt;><br/>..."),
            (
                "test <not br/>tag<br />test <not br/>tag<br />",
                "test <not br/>tag...",
            ),
            (
                "<>< ><tag\n/>>hello    world< br \n />",
                "<>< ><tag\n/>>hello    ...",
            ),
            (
                concat!(
                    "<head><title>ignore head</title><not head>xyz</not head></head>",
                    "<h1>&lt;body&gt;</h1>"
                ),
                "<head><title>ignore he...",
            ),
            (
                concat!(
                    "<p>what is &heartsuit;?</p><p>&#x000DF;&Abreve;&#914;&gamma; ",
                    "don&apos;t hurt me.</p>"
                ),
                "<p>what is &heartsuit;...",
            ),
            (
                "<!-- <> < < < -->the actual<!--> text",
                "<!-- <> < < < -->the a...",
            ),
            (
                "   < p >  hello < / p > < p > world < / p >   !!! < br > ",
                "   < p >  hello ...",
            ),
            (
                " <p>please unsubscribe <a href=#>here</a>.</p> ",
                " <p>please unsubscribe...",
            ),
        ] {
            assert_eq!(super::truncate_html(html.into(), 25), expected_result);
        }
    }
}
