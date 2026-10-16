// Prevents an additional console window on Windows in release. Not a platform we
// ship, but harmless and standard.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    s3viewer_lib::run()
}
