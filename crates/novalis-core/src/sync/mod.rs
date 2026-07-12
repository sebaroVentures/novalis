//! Peer-to-peer, end-to-end-encrypted vault sync (W4.4).
//!
//! An **alternative** sync backend to the git engine in [`crate::git`]: instead
//! of a central git host, two paired devices talk directly (QUIC/NAT-traversal
//! lives in the desktop shell via `iroh`) over an authenticated channel, and
//! every file's *contents* are additionally sealed with a symmetric vault key
//! that never leaves the paired devices. A relay or backup that carries the
//! bytes therefore sees only ciphertext (zero-knowledge).
//!
//! This crate half is deliberately **pure and synchronous** — no tokio, no
//! sockets — so the security-critical logic (crypto, the pairing ticket, the
//! manifest 3-way plan, and the wire framing) is unit-testable in isolation.
//! The async transport (`iroh` endpoint, the read/write loop that drives the
//! [`protocol::Frame`] exchange) lives in the desktop shell, which owns the
//! tokio runtime and the OS keychain that holds the secrets.
//!
//! ## What lives here
//! - [`crypto`] — XChaCha20-Poly1305 sealing of file bytes with the vault key.
//! - [`identity`] — the per-device secret seed that keys the QUIC endpoint.
//! - [`ticket`] — the shareable pairing string (carries the vault key + how to
//!   reach the peer).
//! - [`manifest`] — a content hash of the vault plus the 3-way (base/local/
//!   remote) plan that decides, per file, take / send / conflict.
//! - [`protocol`] — the message enum + its byte (de)serialization; the length
//!   framing and the async loop are the shell's job.
//! - [`store`] — the on-disk (app-data, NOT the vault, NOT the index cache)
//!   record of the vault id and paired peers.
//!
//! ## Boundary (honest)
//! Convergence here is **file-granular**: a file changed on exactly one side
//! propagates; a file changed on both sides diverges and is surfaced as a
//! conflict copy (reusing [`crate::conflict`]) rather than silently merged.
//! Sub-file CRDT/automerge convergence is the documented next step, not
//! implemented.

pub mod crypto;
pub mod identity;
pub mod manifest;
pub mod protocol;
pub mod store;
pub mod ticket;

pub use crypto::VaultKey;
pub use identity::DeviceIdentity;
pub use manifest::{FileAction, Manifest};
pub use protocol::Frame;
pub use ticket::SyncTicket;
