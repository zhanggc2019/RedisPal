package main

import (
	"embed"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"redismanager/internal/redisdesk"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

const appName = "RedisPal"

// main embeds the Vue production build and starts the native Wails application.
func main() {
	frontend, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}
	icon, err := fs.ReadFile(frontend, "logo.png")
	if err != nil {
		log.Printf("load application icon: %v", err)
	}
	profile := os.Getenv("ARDM_WEBVIEW_PROFILE")
	if profile == "" {
		if config, err := os.UserConfigDir(); err == nil {
			// Reuse the existing WebView profile so a rename preserves saved settings and connections.
			profile = filepath.Join(config, "AnotherRedisDesktopManager-Wails", "WebView2")
		}
	}
	windows := application.WindowsOptions{WebviewUserDataPath: profile}
	desktopWindow := &DesktopWindow{icon: icon}
	releaseUpdates := newReleaseUpdates(appVersion)
	configureDesktopTest(&windows, releaseUpdates)
	startup, err := redisdesk.ParseLaunchProfile(os.Args[1:])
	if err != nil {
		log.Print(err)
	}
	app := application.New(application.Options{
		Name: appName,
		Icon: icon,
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(frontend),
		},
		Services: []application.Service{
			application.NewService(redisdesk.NewService(startup)),
			application.NewService(releaseUpdates),
			application.NewService(desktopWindow),
		},
		Windows: windows,
	})
	updates := configureUpdater(app)
	releaseUpdates.signed = updates
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: appName, Width: 1260, Height: 780,
		MinWidth: 860, MinHeight: 520, URL: "/", UseApplicationMenu: updates,
	})
	desktopWindow.attach(app, window)
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
