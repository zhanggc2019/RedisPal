package main

import (
	"encoding/base64"
	"testing"
)

// TestUpdateSettings protects local builds from using an unsigned or unintended release feed.
func TestUpdateSettings(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	if config, err := updateSettings("0.1.0", "", ""); err != nil || config != nil {
		t.Fatal("local build unexpectedly configured an updater")
	}
	if config, err := updateSettings("0.1.0", "https://example.test/updates.json", key); err != nil || len(config.PublicKey) != 32 || len(config.Providers) != 1 {
		t.Fatalf("valid release configuration rejected: %v", err)
	}
	for _, url := range []string{"", "http://example.test", "https://"} {
		if _, err := updateSettings("0.1.0", url, key); err == nil {
			t.Errorf("accepted unexpected update URL %q", url)
		}
	}
	if _, err := updateSettings("0.1.0", "https://example.test/updates.json", "invalid"); err == nil {
		t.Fatal("accepted invalid updater key")
	}
}
