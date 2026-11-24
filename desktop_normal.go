//go:build !ardm_desktop_test

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// configureDesktopTest keeps production builds free of the Playwright debug endpoint.
func configureDesktopTest(_ *application.WindowsOptions, _ *ReleaseUpdates) {}
