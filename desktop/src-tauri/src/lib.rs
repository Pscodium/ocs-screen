use tauri::tray::TrayIconEvent;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            // Fecha o processo de verdade ao fechar a janela principal — sem isso, em alguns
            // ambientes Windows o WebView2 deixa o processo pendurado em segundo plano.
            if let WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
        })
        .on_tray_icon_event(|app, event| {
            // Clique no ícone da bandeja restaura/foca a janela principal.
            if let TrayIconEvent::Click { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running ScreenShare");
}
