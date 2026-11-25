package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"log"
	"net/url"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/endpoint"
)

// Release builds can pin a Wails manifest URL and public key via Go linker flags.
var (
	appVersion        = "0.0.1"
	updateManifestURL string
	updatePublicKey   string
)

// updateSettings enables self-update only for a configured HTTPS feed with a pinned Ed25519 key.
func updateSettings(version, manifestURL, publicKey string) (*updater.Config, error) {
	if manifestURL == "" && publicKey == "" {
		return nil, nil
	}
	address, err := url.Parse(manifestURL)
	if err != nil || address.Scheme != "https" || address.Hostname() == "" || address.User != nil {
		return nil, errors.New("update manifest requires an HTTPS URL")
	}
	key, err := base64.StdEncoding.DecodeString(publicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("updater requires a base64 Ed25519 public key")
	}
	provider, err := endpoint.New(endpoint.Config{URL: manifestURL})
	if err != nil {
		return nil, err
	}
	return &updater.Config{
		CurrentVersion: version,
		Providers:      []updater.Provider{provider},
		PublicKey:      key,
		Window:         updater.WindowNone,
	}, nil
}

// configureUpdater initializes the signed release channel.
func configureUpdater(app *application.App) bool {
	settings, err := updateSettings(appVersion, updateManifestURL, updatePublicKey)
	if err != nil {
		log.Print(err)
		return false
	}
	if settings == nil {
		return false
	}
	if err := app.Updater.Init(*settings); err != nil {
		log.Print(err)
		return false
	}
	return true
}
