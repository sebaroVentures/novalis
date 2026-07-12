//! PDF annotation sidecars (feature W4.2). PDFs live in the vault and are
//! rendered client-side by pdf.js; their highlights are stored in a **portable,
//! user-owned sidecar file** next to the PDF (`<pdf>.annotations.json`) — never
//! in the index/DB, so they survive a reindex, sync as plain files, and can be
//! read by anything. Pure functions over a `vault: &Path`, fully testable.

use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use specta::Type;
use walkdir::WalkDir;

use crate::change;
use crate::error::{CoreError, CoreResult};
use crate::vault::fs as vault_fs;

/// Suffix appended to a PDF's vault-relative path to locate its sidecar.
pub const SIDECAR_SUFFIX: &str = ".annotations.json";
/// Sidecar schema version — bump only on a breaking shape change.
pub const ANNOTATIONS_VERSION: u32 = 1;

/// One rectangle of a highlight, in **normalized page coordinates** (0..1 of the
/// page's width/height, origin top-left). Normalizing makes a highlight
/// resolution- and zoom-independent, so it re-projects onto any render scale.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PdfRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A single text highlight on one page of a PDF.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PdfHighlight {
    /// Stable id (uuid) — the fragment a note back-link points at (`#hl=<id>`).
    pub id: String,
    /// 1-based page number.
    pub page: u32,
    /// Palette token (e.g. `"yellow"`), resolved to a color by the frontend.
    pub color: String,
    /// The selected/quoted text.
    pub text: String,
    /// Optional user annotation attached to the highlight.
    #[serde(default)]
    pub note: Option<String>,
    /// One or more rectangles covering the selection (multi-line selections
    /// produce several), in normalized page coordinates.
    pub rects: Vec<PdfRect>,
    /// Vault-relative paths of notes this highlight has been linked into, so the
    /// side panel can show "linked to …" and open them. Kept in sync by the
    /// frontend after a successful [`link_highlight_to_note`].
    #[serde(default)]
    pub linked_notes: Vec<String>,
    /// RFC 3339 creation timestamp.
    pub created: String,
}

/// The full sidecar document for one PDF.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PdfAnnotations {
    pub version: u32,
    pub highlights: Vec<PdfHighlight>,
}

impl Default for PdfAnnotations {
    fn default() -> Self {
        Self {
            version: ANNOTATIONS_VERSION,
            highlights: Vec::new(),
        }
    }
}

/// Lightweight metadata for a PDF in the vault (the "Open PDF" picker).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PdfSummary {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub modified: String,
    pub highlight_count: usize,
}

/// Whether `path` names a PDF (case-insensitive extension check).
fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// The vault-relative sidecar path for a PDF. Pure string op — the caller
/// guards it through [`vault_fs::vault_rel`] before touching disk.
pub fn sidecar_rel(pdf_path: &str) -> String {
    format!("{pdf_path}{SIDECAR_SUFFIX}")
}

/// List every PDF in the vault (skipping hidden dirs and the `media/` folder,
/// mirroring [`vault_fs::list_notes`]), newest-modified first.
pub fn list_pdfs(vault: &Path) -> Vec<PdfSummary> {
    let mut pdfs = Vec::new();

    for entry in WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| {
            // The vault root is always descended; only its *contents* are
            // filtered — otherwise a vault whose own dir name starts with `.`
            // (or a `.tmp…` test dir) would prune the entire walk.
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            if name.starts_with('.') {
                return false;
            }
            !(e.depth() == 1 && name.as_ref() == "media")
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() || !is_pdf(entry.path()) {
            continue;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(vault)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| relative.clone());
        let folder = relative
            .rsplit_once('/')
            .map(|(f, _)| f.to_string())
            .unwrap_or_default();
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
            .unwrap_or_default();
        // Best-effort highlight count; a malformed sidecar just reports 0.
        let highlight_count = read_annotations(vault, &relative)
            .map(|a| a.highlights.len())
            .unwrap_or(0);

        pdfs.push(PdfSummary {
            path: relative,
            name,
            folder,
            modified,
            highlight_count,
        });
    }

    pdfs.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.name.cmp(&b.name))
    });
    pdfs
}

/// Read a PDF's sidecar annotations. A missing sidecar is not an error — it
/// yields an empty (default) document, so an un-annotated PDF opens cleanly.
pub fn read_annotations(vault: &Path, pdf_path: &str) -> CoreResult<PdfAnnotations> {
    let sidecar = vault_fs::vault_rel(vault, &sidecar_rel(pdf_path))?;
    if !sidecar.exists() {
        return Ok(PdfAnnotations::default());
    }
    let raw = std::fs::read_to_string(&sidecar)?;
    if raw.trim().is_empty() {
        return Ok(PdfAnnotations::default());
    }
    serde_json::from_str(&raw)
        .map_err(|e| CoreError::BadRequest(format!("invalid annotation sidecar: {e}")))
}

/// Write a PDF's sidecar annotations atomically. Writing an **empty** document
/// removes the sidecar instead, so opening/closing a PDF without annotating it
/// leaves no stray files in the vault.
pub fn write_annotations(
    vault: &Path,
    pdf_path: &str,
    annotations: &PdfAnnotations,
) -> CoreResult<()> {
    let sidecar = vault_fs::vault_rel(vault, &sidecar_rel(pdf_path))?;
    if annotations.highlights.is_empty() {
        if sidecar.exists() {
            std::fs::remove_file(&sidecar)?;
        }
        return Ok(());
    }
    let json = serde_json::to_string_pretty(annotations)
        .map_err(|e| CoreError::Internal(format!("serialize annotations: {e}")))?;
    vault_fs::write_atomic(&sidecar, &json)
}

/// The inline markdown link that points a note back at a specific highlight:
/// `[<pdf name> p.<page>](<pdf path>#hl=<id>)`. The `#hl=<id>` fragment lets the
/// viewer re-open on that highlight. Portable plain markdown (not a `[[wikilink]]`,
/// which resolves only to notes).
pub fn highlight_link(pdf_path: &str, hl: &PdfHighlight) -> String {
    let name = pdf_path.rsplit('/').next().unwrap_or(pdf_path);
    format!(
        "[{name} p.{page}]({path}#hl={id})",
        page = hl.page,
        path = pdf_path,
        id = hl.id
    )
}

/// The markdown block inserted into (or copied from) a note for a highlight: the
/// quoted text as a blockquote, then an attribution line linking back to the
/// PDF highlight, with the user's note appended when present.
pub fn highlight_snippet(pdf_path: &str, hl: &PdfHighlight) -> String {
    let quoted = hl
        .text
        .trim()
        .lines()
        .map(|l| format!("> {l}").trim_end().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = format!(
        "{quoted}\n>\n> — {link}",
        link = highlight_link(pdf_path, hl)
    );
    if let Some(note) = hl.note.as_ref().map(|n| n.trim()).filter(|n| !n.is_empty()) {
        out.push_str(&format!(" — {note}"));
    }
    out
}

/// The default note a highlight is filed into when the caller names no target:
/// `<pdf stem> Highlights.md`, beside the PDF.
pub fn default_highlights_note(pdf_path: &str) -> String {
    let (dir, file) = match pdf_path.rsplit_once('/') {
        Some((d, f)) => (format!("{d}/"), f),
        None => (String::new(), pdf_path),
    };
    let stem = file
        .strip_suffix(".pdf")
        .or_else(|| file.strip_suffix(".PDF"))
        .unwrap_or(file);
    format!("{dir}{stem} Highlights.md")
}

/// Append a highlight's snippet to a note, creating the note if it doesn't yet
/// exist. `target` is a vault-relative `.md` path; `None` files it into the PDF's
/// default highlights note. Re-indexes the note so its links/backlinks update.
/// Returns the target note's vault-relative path.
pub fn link_highlight_to_note(
    db: &Connection,
    vault: &Path,
    data_dir: &Path,
    pdf_path: &str,
    hl: &PdfHighlight,
    target: Option<&str>,
) -> CoreResult<String> {
    let _ = data_dir; // reserved for future template support; kept for signature parity
    let target = target
        .map(|t| t.to_string())
        .unwrap_or_else(|| default_highlights_note(pdf_path));
    if !target.to_lowercase().ends_with(".md") {
        return Err(CoreError::BadRequest(format!(
            "highlight target must be a .md note: {target}"
        )));
    }
    // A leading blank line separates the appended block from prior content so
    // the blockquote renders as its own block. `append_line` creates the note
    // (with default frontmatter) when it's missing.
    let snippet = highlight_snippet(pdf_path, hl);
    vault_fs::append_line(vault, &target, &format!("\n{snippet}"))?;
    change::reindex_path(db, vault, &target)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema;

    fn hl(id: &str, page: u32, text: &str) -> PdfHighlight {
        PdfHighlight {
            id: id.to_string(),
            page,
            color: "yellow".to_string(),
            text: text.to_string(),
            note: None,
            rects: vec![PdfRect {
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.02,
            }],
            linked_notes: Vec::new(),
            created: "2026-07-12T00:00:00Z".to_string(),
        }
    }

    fn tmp_vault() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn sidecar_path_is_pdf_plus_suffix() {
        assert_eq!(
            sidecar_rel("docs/paper.pdf"),
            "docs/paper.pdf.annotations.json"
        );
    }

    #[test]
    fn missing_sidecar_reads_as_empty() {
        let v = tmp_vault();
        let a = read_annotations(v.path(), "nope.pdf").unwrap();
        assert_eq!(a.version, ANNOTATIONS_VERSION);
        assert!(a.highlights.is_empty());
    }

    #[test]
    fn write_then_read_roundtrips() {
        let v = tmp_vault();
        std::fs::write(v.path().join("paper.pdf"), b"%PDF-1.4").unwrap();
        let mut doc = PdfAnnotations::default();
        doc.highlights.push(hl("abc", 3, "hello world"));
        write_annotations(v.path(), "paper.pdf", &doc).unwrap();

        assert!(v.path().join("paper.pdf.annotations.json").exists());
        let back = read_annotations(v.path(), "paper.pdf").unwrap();
        assert_eq!(back, doc);
    }

    #[test]
    fn writing_empty_removes_the_sidecar() {
        let v = tmp_vault();
        let mut doc = PdfAnnotations::default();
        doc.highlights.push(hl("abc", 1, "x"));
        write_annotations(v.path(), "paper.pdf", &doc).unwrap();
        assert!(v.path().join("paper.pdf.annotations.json").exists());

        write_annotations(v.path(), "paper.pdf", &PdfAnnotations::default()).unwrap();
        assert!(!v.path().join("paper.pdf.annotations.json").exists());
    }

    #[test]
    fn path_traversal_is_rejected() {
        let v = tmp_vault();
        assert!(read_annotations(v.path(), "../secret.pdf").is_err());
        assert!(write_annotations(v.path(), "../secret.pdf", &PdfAnnotations::default()).is_err());
    }

    #[test]
    fn snippet_and_link_formatting() {
        let mut h = hl("id1", 4, "quoted line one\nline two");
        let link = highlight_link("docs/paper.pdf", &h);
        assert_eq!(link, "[paper.pdf p.4](docs/paper.pdf#hl=id1)");

        let snippet = highlight_snippet("docs/paper.pdf", &h);
        assert_eq!(
            snippet,
            "> quoted line one\n> line two\n>\n> — [paper.pdf p.4](docs/paper.pdf#hl=id1)"
        );

        h.note = Some("my thought".to_string());
        assert!(highlight_snippet("docs/paper.pdf", &h).ends_with("#hl=id1) — my thought"));
    }

    #[test]
    fn default_note_sits_beside_the_pdf() {
        assert_eq!(
            default_highlights_note("a/b/paper.pdf"),
            "a/b/paper Highlights.md"
        );
        assert_eq!(default_highlights_note("paper.pdf"), "paper Highlights.md");
    }

    #[test]
    fn list_pdfs_finds_and_counts() {
        let v = tmp_vault();
        std::fs::create_dir_all(v.path().join("media")).unwrap();
        std::fs::write(v.path().join("a.pdf"), b"%PDF").unwrap();
        std::fs::write(v.path().join("note.md"), b"x").unwrap();
        std::fs::write(v.path().join("media/skip.pdf"), b"%PDF").unwrap();

        let mut doc = PdfAnnotations::default();
        doc.highlights.push(hl("h", 1, "t"));
        write_annotations(v.path(), "a.pdf", &doc).unwrap();

        let pdfs = list_pdfs(v.path());
        assert_eq!(pdfs.len(), 1, "media/ is skipped, .md ignored");
        assert_eq!(pdfs[0].path, "a.pdf");
        assert_eq!(pdfs[0].highlight_count, 1);
    }

    #[test]
    fn link_highlight_appends_and_creates() {
        let v = tmp_vault();
        let db = schema::open_db(&v.path().join("i.db")).unwrap();
        let data = v.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(v.path().join("paper.pdf"), b"%PDF").unwrap();

        let h = hl("hh", 2, "an insight");
        // Default target — creates "paper Highlights.md".
        let note = link_highlight_to_note(&db, v.path(), &data, "paper.pdf", &h, None).unwrap();
        assert_eq!(note, "paper Highlights.md");
        let body = std::fs::read_to_string(v.path().join(&note)).unwrap();
        assert!(body.contains("> an insight"));
        assert!(body.contains("#hl=hh"));

        // Second append into the same note keeps prior content.
        let h2 = hl("hh2", 3, "second");
        link_highlight_to_note(&db, v.path(), &data, "paper.pdf", &h2, Some(&note)).unwrap();
        let body = std::fs::read_to_string(v.path().join(&note)).unwrap();
        assert!(body.contains("> an insight") && body.contains("> second"));

        // A non-.md target is rejected.
        assert!(
            link_highlight_to_note(&db, v.path(), &data, "paper.pdf", &h, Some("x.txt")).is_err()
        );
    }
}
