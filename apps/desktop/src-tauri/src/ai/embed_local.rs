//! Bundled, on-device text embeddings — semantic search with nothing installed.
//!
//! Wraps the `fastembed` crate (ONNX Runtime via `ort`, HuggingFace
//! `tokenizers`) running **bge-small-en-v1.5** (384-dim English embeddings), as
//! a selectable alternative to the OpenAI-compatible HTTP adapter in
//! [`super::embeddings`]. Selected via [`novalis_core::models::
//! LOCAL_EMBEDDING_CONNECTION_ID`]; its vectors are stored under the distinct
//! model id [`novalis_core::models::LOCAL_EMBEDDING_MODEL`].
//!
//! ## Bundled vs downloaded
//! The ONNX Runtime *library* is linked at build time (the `ort`
//! `download-binaries` feature fetches a prebuilt binary during `cargo build`),
//! so no runtime download of the inference engine is needed. The model
//! *weights* (~130 MB) are fetched from HuggingFace on first use and cached
//! under the app-data dir; every subsequent build runs fully offline.
//!
//! ## Threading
//! `fastembed` is CPU-bound and blocking, and its `embed` takes `&mut self`, so
//! every call here MUST run on a blocking thread — never on the async runtime,
//! never under the engine lock. The loaded model is reused across batches;
//! loading it (plus the one-time weight download) is the expensive part.
//!
//! ## Platform
//! Desktop only. `ort`'s prebuilt ONNX Runtime isn't available for Android, so
//! this module is compiled out there (see `crate::ai` / `crate::secrets`); a
//! "local" embedding config surfaces a clear error on that platform instead.

use std::path::Path;
use std::sync::{Arc, Mutex};

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

use crate::engine::CommandError;

/// The bundled model: small, fast, 384-dim English embeddings. Its stored
/// `note_vectors.model` id is [`novalis_core::models::LOCAL_EMBEDDING_MODEL`].
const MODEL: EmbeddingModel = EmbeddingModel::BGESmallENV15;

/// A loaded on-device embedder. Cheap to clone (an `Arc` to one shared model);
/// concurrent `embed` calls serialize on the inner mutex because `fastembed`
/// requires `&mut self`.
#[derive(Clone)]
pub struct LocalEmbedder {
    model: Arc<Mutex<TextEmbedding>>,
}

/// Load (or, on first use, download + cache) failures — a distinct `kind` from
/// the HTTP adapter's network errors so the settings panel can surface a
/// model/engine problem plainly.
fn load_err(msg: impl Into<String>) -> CommandError {
    CommandError {
        kind: "aiEmbedLocal".to_string(),
        message: msg.into(),
    }
}

/// Reuse the HTTP adapter's `aiBadRequest` kind for a malformed batch, so a bad
/// local batch is rejected identically downstream.
fn bad_batch(msg: impl Into<String>) -> CommandError {
    CommandError {
        kind: "aiBadRequest".to_string(),
        message: msg.into(),
    }
}

/// Load the bundled model, caching weights under `cache_dir` (created if
/// absent). Blocking and potentially slow (first use downloads ~130 MB) — run it
/// on a blocking thread.
pub fn load(cache_dir: &Path) -> Result<LocalEmbedder, CommandError> {
    std::fs::create_dir_all(cache_dir)
        .map_err(|e| load_err(format!("cannot create embedding-model cache dir: {e}")))?;
    let model = TextEmbedding::try_new(
        InitOptions::new(MODEL)
            .with_cache_dir(cache_dir.to_path_buf())
            .with_show_download_progress(false),
    )
    .map_err(|e| load_err(format!("failed to load the local embedding model: {e}")))?;
    Ok(LocalEmbedder {
        model: Arc::new(Mutex::new(model)),
    })
}

impl LocalEmbedder {
    /// Embed `inputs` into one vector each, in input order. Blocking — run on a
    /// blocking thread. Validates the output the same way the HTTP adapter does
    /// so a malformed batch can't poison the cosine math downstream.
    pub fn embed(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>, CommandError> {
        let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
        // `fastembed` accepts any `AsRef<[S: AsRef<str>]>`, so the slice is fine.
        let vecs = model
            .embed(inputs, None)
            .map_err(|e| load_err(format!("local embedding failed: {e}")))?;
        validate(&vecs, inputs.len())?;
        Ok(vecs)
    }
}

/// Reject a malformed batch: one vector per input, a consistent non-zero
/// dimension, all values finite, and not entirely zero. Mirrors the HTTP
/// adapter's `validate_rows` checks and messages in [`super::embeddings`].
fn validate(vecs: &[Vec<f32>], expected: usize) -> Result<(), CommandError> {
    if vecs.len() != expected {
        return Err(bad_batch(format!(
            "embeddings: expected {expected} vectors, got {}",
            vecs.len()
        )));
    }
    let dim = vecs.first().map(Vec::len).unwrap_or(0);
    if dim == 0 {
        return Err(bad_batch("embeddings: empty embedding returned"));
    }
    let mut any_nonzero = false;
    for v in vecs {
        if v.len() != dim {
            return Err(bad_batch("embeddings: inconsistent vector dimensions"));
        }
        if v.iter().any(|x| !x.is_finite()) {
            return Err(bad_batch("embeddings: non-finite values in embedding"));
        }
        any_nonzero |= v.iter().any(|x| *x != 0.0);
    }
    if !any_nonzero {
        return Err(bad_batch(
            "embeddings: all-zero embeddings (check the model)",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // The validation contract is unit-tested here (pure, no model load). Real
    // model inference is exercised out-of-band (downloading ~130 MB is unfit for
    // unit tests, exactly as the HTTP adapter mocks its endpoint rather than
    // hitting a live API).
    use super::*;

    #[test]
    fn validate_accepts_a_well_formed_batch() {
        let vecs = vec![vec![1.0, 0.0], vec![0.0, 1.0]];
        assert!(validate(&vecs, 2).is_ok());
    }

    #[test]
    fn validate_rejects_count_mismatch() {
        let err = validate(&[vec![1.0]], 2).unwrap_err();
        assert_eq!(err.kind, "aiBadRequest");
        assert!(err.message.contains("expected 2 vectors, got 1"));
    }

    #[test]
    fn validate_rejects_inconsistent_dimensions() {
        let vecs = vec![vec![1.0, 2.0], vec![1.0]];
        let err = validate(&vecs, 2).unwrap_err();
        assert_eq!(err.kind, "aiBadRequest");
        assert!(err.message.contains("inconsistent vector dimensions"));
    }

    #[test]
    fn validate_rejects_non_finite_values() {
        let vecs = vec![vec![1.0, f32::INFINITY]];
        let err = validate(&vecs, 1).unwrap_err();
        assert!(err.message.contains("non-finite"));
    }

    #[test]
    fn validate_rejects_all_zero() {
        let vecs = vec![vec![0.0, 0.0]];
        let err = validate(&vecs, 1).unwrap_err();
        assert!(err.message.contains("all-zero"));
    }

    #[test]
    fn validate_rejects_empty_embedding() {
        let vecs = vec![vec![]];
        let err = validate(&vecs, 1).unwrap_err();
        assert!(err.message.contains("empty embedding"));
    }
}
