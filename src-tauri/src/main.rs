// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if cross_di_lib::handle_browser_arguments() {
        return;
    }
    cross_di_lib::run()
}
