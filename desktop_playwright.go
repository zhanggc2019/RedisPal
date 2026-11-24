//go:build ardm_desktop_test

package main

import (
	"os"
	"strconv"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// configureDesktopTest sets the disposable WebView and update endpoint for Playwright.
func configureDesktopTest(options *application.WindowsOptions, updates *ReleaseUpdates) {
	updates.endpoint = os.Getenv("ARDM_TEST_UPDATE_URL")
	port, err := strconv.ParseUint(os.Getenv("ARDM_TEST_CDP_PORT"), 10, 16)
	if err == nil && port > 0 {
		options.AdditionalBrowserArgs = append(options.AdditionalBrowserArgs,
			"--remote-debugging-port="+strconv.FormatUint(port, 10), "--remote-debugging-address=127.0.0.1", "--lang=en-US")
	}
}
