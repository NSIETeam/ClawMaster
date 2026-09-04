#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(result) = clawmaster_desktop_lib::native_tools::dispatch_from_args(&args) {
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(2);
        }
        return;
    }
    clawmaster_desktop_lib::run();
}
