//! Export a note's markdown body to a styled HTML document or a Word (.docx)
//! file. Pure builders returning a `String` / `Vec<u8>` — the shell handles the
//! save dialog and writing the file.

use std::io::Cursor;

use docx_rs::{BreakType, Docx, Paragraph, Run, RunFonts};
use pulldown_cmark::{html, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::error::{CoreError, CoreResult};

/// Escape text for interpolation into HTML. The body is escaped by
/// pulldown-cmark's renderer; this covers the raw note title (a hostile
/// `</title><script>…` title must not produce script-bearing export HTML).
/// The docx path needs no equivalent: docx-rs XML-escapes text runs itself.
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Render a note body to a standalone, styled HTML document.
pub fn note_html(title: &str, body: &str) -> String {
    let parser = Parser::new_ext(body, Options::all());
    let mut html_body = String::new();
    html::push_html(&mut html_body, parser);
    let title = escape_html(title);

    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }}
        h1, h2, h3, h4, h5, h6 {{ color: #1a1a1a; margin-top: 1.5em; }}
        code {{ background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }}
        pre {{ background: #f4f4f4; padding: 16px; border-radius: 6px; overflow-x: auto; }}
        pre code {{ background: none; padding: 0; }}
        blockquote {{ border-left: 4px solid #ddd; margin-left: 0; padding-left: 16px; color: #666; }}
        a {{ color: #0066cc; }}
        img {{ max-width: 100%; }}
        table {{ border-collapse: collapse; width: 100%; }}
        th, td {{ border: 1px solid #ddd; padding: 8px 12px; text-align: left; }}
        th {{ background: #f4f4f4; }}
        input[type="checkbox"] {{ margin-right: 8px; }}
    </style>
</head>
<body>
{html_body}
</body>
</html>"#
    )
}

/// Render a note body to a `.docx` byte buffer.
pub fn note_docx(title: &str, body: &str) -> CoreResult<Vec<u8>> {
    let docx = build_docx(title, body);
    let mut buf = Vec::new();
    docx.build()
        .pack(Cursor::new(&mut buf))
        .map_err(|e| CoreError::Internal(format!("DOCX pack failed: {e}")))?;
    Ok(buf)
}

// Half-points (docx unit). 24 == 12pt body text.
const BODY_SIZE: usize = 24;
const HEADING_SIZES: [usize; 6] = [40, 32, 28, 26, 24, 22];
const MONO_FONT: &str = "Courier New";

fn heading_size(level: HeadingLevel) -> usize {
    let idx = match level {
        HeadingLevel::H1 => 0,
        HeadingLevel::H2 => 1,
        HeadingLevel::H3 => 2,
        HeadingLevel::H4 => 3,
        HeadingLevel::H5 => 4,
        HeadingLevel::H6 => 5,
    };
    HEADING_SIZES[idx]
}

struct ListState {
    ordered: bool,
    index: u64,
}

struct Builder {
    docx: Docx,
    para: Paragraph,
    run_size: usize,
    bold: u32,
    italic: u32,
    code: u32,
    list_stack: Vec<ListState>,
    in_block: bool,
}

impl Builder {
    fn new() -> Self {
        Self {
            docx: Docx::new(),
            para: Paragraph::new(),
            run_size: BODY_SIZE,
            bold: 0,
            italic: 0,
            code: 0,
            list_stack: Vec::new(),
            in_block: false,
        }
    }

    fn start_block(&mut self, size: usize) {
        if self.in_block {
            self.flush();
        }
        self.para = Paragraph::new();
        self.run_size = size;
        self.in_block = true;
    }

    fn flush(&mut self) {
        let p = std::mem::replace(&mut self.para, Paragraph::new());
        self.docx = std::mem::replace(&mut self.docx, Docx::new()).add_paragraph(p);
        self.in_block = false;
        self.run_size = BODY_SIZE;
    }

    fn push_text(&mut self, text: &str) {
        if !self.in_block {
            self.start_block(BODY_SIZE);
        }
        let mut run = Run::new().add_text(text).size(self.run_size);
        if self.bold > 0 {
            run = run.bold();
        }
        if self.italic > 0 {
            run = run.italic();
        }
        if self.code > 0 {
            run = run.fonts(RunFonts::new().ascii(MONO_FONT).hi_ansi(MONO_FONT));
        }
        self.para = std::mem::replace(&mut self.para, Paragraph::new()).add_run(run);
    }

    fn push_break(&mut self) {
        if !self.in_block {
            return;
        }
        let run = Run::new().add_break(BreakType::TextWrapping);
        self.para = std::mem::replace(&mut self.para, Paragraph::new()).add_run(run);
    }

    fn list_prefix(&mut self) -> String {
        let depth = self.list_stack.len().saturating_sub(1);
        let indent = "    ".repeat(depth);
        match self.list_stack.last_mut() {
            Some(state) if state.ordered => {
                let n = state.index;
                state.index += 1;
                format!("{indent}{n}. ")
            }
            Some(_) => format!("{indent}• "),
            None => String::new(),
        }
    }
}

fn build_docx(title: &str, markdown: &str) -> Docx {
    let mut b = Builder::new();

    b.start_block(HEADING_SIZES[0]);
    b.bold += 1;
    b.push_text(title);
    b.bold -= 1;
    b.flush();

    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS;
    let parser = Parser::new_ext(markdown, options);

    for event in parser {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    b.start_block(heading_size(level));
                    b.bold += 1;
                }
                Tag::Paragraph => {
                    if b.list_stack.is_empty() {
                        b.start_block(BODY_SIZE);
                    } else if !b.in_block {
                        b.start_block(BODY_SIZE);
                        let prefix = b.list_prefix();
                        b.push_text(&prefix);
                    }
                }
                Tag::BlockQuote(_) => {
                    b.start_block(BODY_SIZE);
                    b.italic += 1;
                }
                Tag::CodeBlock(kind) => {
                    b.start_block(BODY_SIZE);
                    b.code += 1;
                    if let CodeBlockKind::Fenced(lang) = kind {
                        if !lang.is_empty() {
                            b.push_text(&format!("[{lang}]"));
                            b.push_break();
                        }
                    }
                }
                Tag::List(start) => {
                    b.list_stack.push(ListState {
                        ordered: start.is_some(),
                        index: start.unwrap_or(1),
                    });
                }
                Tag::Item => {
                    if b.in_block {
                        b.flush();
                    }
                    b.start_block(BODY_SIZE);
                    let prefix = b.list_prefix();
                    b.push_text(&prefix);
                }
                Tag::Emphasis => b.italic += 1,
                Tag::Strong => b.bold += 1,
                _ => {}
            },
            Event::End(end) => match end {
                TagEnd::Heading(_) => {
                    b.bold = b.bold.saturating_sub(1);
                    b.flush();
                }
                TagEnd::Paragraph => b.flush(),
                TagEnd::BlockQuote(_) => {
                    b.italic = b.italic.saturating_sub(1);
                    b.flush();
                }
                TagEnd::CodeBlock => {
                    b.code = b.code.saturating_sub(1);
                    b.flush();
                }
                TagEnd::List(_) => {
                    b.list_stack.pop();
                }
                TagEnd::Item => {
                    if b.in_block {
                        b.flush();
                    }
                }
                TagEnd::Emphasis => b.italic = b.italic.saturating_sub(1),
                TagEnd::Strong => b.bold = b.bold.saturating_sub(1),
                _ => {}
            },
            Event::Text(t) => b.push_text(&t),
            Event::Code(t) => {
                b.code += 1;
                b.push_text(&t);
                b.code -= 1;
            }
            Event::SoftBreak => b.push_text(" "),
            Event::HardBreak => b.push_break(),
            Event::Rule => {
                b.start_block(BODY_SIZE);
                b.push_text("―――");
                b.flush();
            }
            Event::TaskListMarker(checked) => {
                b.push_text(if checked { "[x] " } else { "[ ] " });
            }
            _ => {}
        }
    }

    if b.in_block {
        b.flush();
    }

    b.docx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_includes_title_and_rendered_body() {
        let html = note_html("My Note", "# Hello\n\nsome **bold** text");
        assert!(html.contains("<title>My Note</title>"));
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<h1>Hello</h1>"));
    }

    #[test]
    fn html_escapes_hostile_title() {
        let html = note_html("</title><script>alert(1)</script>", "body");
        assert!(!html.contains("<script>"), "title must not inject markup");
        assert!(html.contains("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
    }

    #[test]
    fn docx_produces_nonempty_zip() {
        let bytes = note_docx("My Note", "# Hello\n\n- a\n- b").unwrap();
        // .docx is a zip; it starts with "PK".
        assert!(bytes.len() > 100);
        assert_eq!(&bytes[..2], b"PK");
    }

    #[test]
    fn docx_survives_hostile_title() {
        // docx-rs escapes text runs itself; a markup-laden title must still
        // pack into a valid archive rather than corrupt the document XML.
        let bytes = note_docx("</w:t></w:r><script>", "body").unwrap();
        assert_eq!(&bytes[..2], b"PK");
    }
}
