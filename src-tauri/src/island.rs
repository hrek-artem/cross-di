use crate::settings::{Alignment, IslandSettings, SettingsState, get_settings};
use tauri::{LogicalSize, Monitor, PhysicalPosition, PhysicalSize, State, WebviewWindow};

#[cfg(windows)]
mod outside_click;
#[cfg(windows)]
mod windows_frame;

#[tauri::command]
pub(crate) fn set_island_expanded(
    window: WebviewWindow,
    state: State<SettingsState>,
    expanded: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("This command only applies to the island window.".into());
    }

    let settings = get_settings(state)?;
    set_window_mode(&window, &settings, expanded).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    if let Err(error) = outside_click::watch(&window, expanded) {
        eprintln!("Could not update island click monitoring: {error}");
    }
    Ok(())
}

pub(crate) fn initialize_window(
    window: &WebviewWindow,
    settings: &IslandSettings,
) -> tauri::Result<()> {
    #[cfg(windows)]
    {
        windows_frame::install(window.hwnd()?)?;
        position_window(window, settings)?;
    }

    #[cfg(not(windows))]
    {
        use tauri::{Emitter, WindowEvent};

        let island = window.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Focused(false)) {
                let _ = island.emit("island-outside-click", ());
            }
        });
    }

    set_window_mode(window, settings, false)?;
    window.show()
}

#[cfg(windows)]
fn set_window_mode(
    window: &WebviewWindow,
    settings: &IslandSettings,
    expanded: bool,
) -> tauri::Result<()> {
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject, HGDIOBJ, SetWindowRgn};

    let hwnd = window.hwnd()?;
    let region = if expanded {
        None
    } else {
        let size = window.inner_size()?;
        let compact = LogicalSize::new(220, 36).to_physical::<u32>(window.scale_factor()?);
        let space = size.width.saturating_sub(compact.width);
        let left = match settings.alignment {
            Alignment::Left => 0,
            Alignment::Center => space / 2,
            Alignment::Right => space,
        };
        let region = unsafe {
            CreateRectRgn(
                left as i32,
                0,
                (left + compact.width).min(size.width) as i32,
                compact.height.min(size.height) as i32,
            )
        };
        if region.is_invalid() {
            return Err(std::io::Error::other("Could not create the island window region").into());
        }
        Some(region)
    };

    if unsafe { SetWindowRgn(hwnd, region, true) } == 0 {
        if let Some(region) = region {
            // The system takes ownership of the region only if SetWindowRgn succeeds.
            unsafe {
                let _ = DeleteObject(HGDIOBJ(region.0));
            }
        }
        return Err(std::io::Error::other("Could not update the island window region").into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_window_mode(
    window: &WebviewWindow,
    settings: &IslandSettings,
    expanded: bool,
) -> tauri::Result<()> {
    let monitor = window.current_monitor()?;
    let size = if expanded {
        LogicalSize::new(340, 190)
    } else {
        LogicalSize::new(220, 36)
    };
    let Some(monitor) = monitor else {
        return window.set_size(size);
    };
    let physical_size = size.to_physical(monitor.scale_factor());
    let position = window_position(settings, &monitor, physical_size);

    window.set_size(size)?;
    window.set_position(position)
}

pub(crate) fn position_window(
    window: &WebviewWindow,
    settings: &IslandSettings,
) -> tauri::Result<()> {
    if let Some(monitor) = window.current_monitor()? {
        window.set_position(window_position(settings, &monitor, window.outer_size()?))?;
    }

    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::RECT,
            Graphics::Gdi::{ERROR, GetWindowRgnBox},
        };

        let mut bounds = RECT::default();
        if unsafe { GetWindowRgnBox(window.hwnd()?, &mut bounds) }.0 != ERROR {
            set_window_mode(window, settings, false)?;
        }
    }
    Ok(())
}

fn window_position(
    settings: &IslandSettings,
    monitor: &Monitor,
    size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let work_area = monitor.work_area();
    let horizontal_space = work_area.size.width.saturating_sub(size.width);
    let vertical_space = work_area.size.height.saturating_sub(size.height);
    let side_margin = ((12.0 * monitor.scale_factor()).round() as u32).min(horizontal_space);
    let left_offset = match settings.alignment {
        Alignment::Left => side_margin,
        Alignment::Center => horizontal_space / 2,
        Alignment::Right => horizontal_space - side_margin,
    };
    let top_offset = ((f64::from(settings.top_offset) * monitor.scale_factor()).round() as u32)
        .min(vertical_space);

    PhysicalPosition::new(
        work_area.position.x + left_offset as i32,
        work_area.position.y + top_offset as i32,
    )
}
