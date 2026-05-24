//! Standalone entry point to (re)generate the TypeScript IPC bindings without
//! launching the app. Run with `pnpm gen:bindings`.

fn main() {
    novalis_desktop_lib::export_bindings();
    println!("\u{2713} exported TypeScript bindings to frontend/src/ipc/bindings.ts");
}
