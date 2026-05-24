//! # novalis-extension
//!
//! The internal extension API that Novalis's first-party features (Notes,
//! Tasks, Calendar) are built against. Dogfooding this boundary now means that
//! when it is promoted to a **public plugin API** (milestone M5) it has already
//! been proven by real modules rather than designed in a vacuum.
//!
//! M0 ships only the shape of the contract; capabilities, command routing, and
//! sandboxing are filled in as features land.

use novalis_core::CoreResult;

/// A self-contained unit of functionality (notes, tasks, calendar, or a
/// third-party plugin) that plugs into the Novalis runtime.
pub trait FeatureModule: Send + Sync {
    /// Stable, unique identifier, e.g. `"notes"` or `"calendar"`.
    fn id(&self) -> &str;

    /// Human-readable name for settings/plugin UIs.
    fn name(&self) -> &str;

    /// Called once when the module is registered. Default: no-op.
    fn init(&mut self) -> CoreResult<()> {
        Ok(())
    }
}

/// Holds the set of registered [`FeatureModule`]s. The runtime owns one of
/// these; commands are dispatched through it once routing lands (M5).
#[derive(Default)]
pub struct Registry {
    modules: Vec<Box<dyn FeatureModule>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a module, running its `init` hook.
    pub fn register(&mut self, mut module: Box<dyn FeatureModule>) -> CoreResult<()> {
        module.init()?;
        self.modules.push(module);
        Ok(())
    }

    /// Ids of all registered modules, in registration order.
    pub fn ids(&self) -> Vec<&str> {
        self.modules.iter().map(|m| m.id()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dummy;
    impl FeatureModule for Dummy {
        fn id(&self) -> &str {
            "dummy"
        }
        fn name(&self) -> &str {
            "Dummy"
        }
    }

    #[test]
    fn registers_and_lists_modules() {
        let mut reg = Registry::new();
        reg.register(Box::new(Dummy)).unwrap();
        assert_eq!(reg.ids(), vec!["dummy"]);
    }
}
