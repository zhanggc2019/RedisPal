package main

import (
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// DesktopWindow coordinates window closing with the frontend and the native tray.
type DesktopWindow struct {
	app      *application.App
	window   *application.WebviewWindow
	icon     []byte
	tray     *application.SystemTray
	openItem *application.MenuItem
	quitItem *application.MenuItem
	ready    atomic.Bool
	pending  atomic.Bool
}

// attach intercepts the native close command before Wails destroys the window.
func (d *DesktopWindow) attach(app *application.App, window *application.WebviewWindow) {
	d.app, d.window = app, window
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		event.Cancel()
		d.pending.Store(true)
		if d.ready.Load() && d.pending.Swap(false) {
			window.EmitEvent("redispal:close-requested")
		}
	})
}

// ReadyForCloseRequests delivers any request made while the frontend was starting.
func (d *DesktopWindow) ReadyForCloseRequests() bool {
	d.ready.Store(true)
	return d.pending.Swap(false)
}

// MinimiseToTray exposes a native way back to the workspace before hiding it.
func (d *DesktopWindow) MinimiseToTray(openLabel, quitLabel string) {
	application.InvokeSync(func() {
		if d.tray == nil {
			d.tray = d.app.SystemTray.New()
			if len(d.icon) != 0 {
				d.tray.SetIcon(d.icon)
			}
			d.tray.SetTooltip(appName)
			d.tray.OnClick(d.restore).OnDoubleClick(d.restore).OnRightClick(d.tray.OpenMenu)
			menu := d.app.Menu.New()
			d.openItem = menu.Add(openLabel).OnClick(func(*application.Context) { d.restore() })
			d.quitItem = menu.Add(quitLabel).OnClick(func(*application.Context) { d.app.Quit() })
			d.tray.SetMenu(menu)
		} else {
			d.openItem.SetLabel(openLabel)
			d.quitItem.SetLabel(quitLabel)
		}
		d.tray.Show()
		d.window.Hide()
	})
}

// restore shows and focuses the same live WebView window.
func (d *DesktopWindow) restore() {
	application.InvokeSync(func() {
		d.window.Show()
		d.window.UnMinimise()
		d.window.Focus()
		d.tray.Hide()
	})
}
