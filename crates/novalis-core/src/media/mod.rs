//! Image/attachment storage inside the vault's `media/` folder.

use std::path::{Path, PathBuf};

use crate::error::{CoreError, CoreResult};

/// Allowed image extensions mapped to MIME types.
pub fn mime_for_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => return None,
    })
}

/// The vault's media directory.
pub fn media_dir(vault: &Path) -> PathBuf {
    vault.join("media")
}

/// Save image `bytes` into `media/`, returning the vault-relative path
/// (`media/<uuid>.<ext>`) for embedding as `![](...)`.
pub fn save_image(vault: &Path, bytes: &[u8], ext: &str) -> CoreResult<String> {
    let ext = ext.trim_start_matches('.').to_lowercase();
    if mime_for_ext(&ext).is_none() {
        return Err(CoreError::BadRequest(format!(
            "Unsupported image type: {ext}"
        )));
    }

    let dir = media_dir(vault);
    std::fs::create_dir_all(&dir)?;

    let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    std::fs::write(dir.join(&filename), bytes)?;
    Ok(format!("media/{filename}"))
}

/// Read an image from `media/`, rejecting path traversal outside it.
pub fn read_image(vault: &Path, relative: &str) -> CoreResult<Vec<u8>> {
    let sanitized = relative
        .trim_start_matches("media/")
        .split('/')
        .filter(|seg| !seg.is_empty() && *seg != "..")
        .collect::<Vec<_>>()
        .join("/");

    let dir = media_dir(vault);
    let resolved = dir
        .join(&sanitized)
        .canonicalize()
        .map_err(|_| CoreError::NotFound("Media file not found".to_string()))?;
    let canon_dir = dir.canonicalize().unwrap_or(dir);
    if !resolved.starts_with(&canon_dir) {
        return Err(CoreError::NotFound("Media file not found".to_string()));
    }

    Ok(std::fs::read(&resolved)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_then_read_roundtrip() {
        let vault = std::env::temp_dir().join(format!("novalis-media-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&vault).unwrap();

        let rel = save_image(&vault, b"\x89PNG\r\n\x1a\n fake", "png").unwrap();
        assert!(rel.starts_with("media/") && rel.ends_with(".png"));
        let bytes = read_image(&vault, &rel).unwrap();
        assert_eq!(&bytes[..4], b"\x89PNG");

        assert!(save_image(&vault, b"x", "exe").is_err());
        std::fs::remove_dir_all(&vault).ok();
    }
}
