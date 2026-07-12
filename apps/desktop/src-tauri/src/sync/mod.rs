//! Desktop shell for W4.4 peer-to-peer, E2E-encrypted vault sync — the async
//! half that the pure `novalis_core::sync` core cannot host (tokio + `iroh` +
//! the OS keychain).
//!
//! - [`session`] — the transport-agnostic protocol driver (deterministically
//!   tested over an in-memory pipe with real encryption).
//! - [`endpoint`] — the `iroh` QUIC transport (desktop-only, like `fastembed`).
//! - [`service`] — keychain + store + transport glue behind four command entry
//!   points.
//!
//! This is an **opt-in alternative** to the git sync backend ([`crate`]'s
//! `git_*` commands); the two never touch each other's state.

#[cfg(desktop)]
mod endpoint;
pub mod service;
#[cfg(desktop)]
mod session;
