package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/endpoint"
)

// TestReleaseUpdateCheck compares stable releases numerically and only links to the official repository.
func TestReleaseUpdateCheck(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   string
		fails  bool
	}{
		{name: "latest", status: 200, body: `{"tag_name":"v0.0.10","html_url":"https://untrusted.invalid"}`, want: "v0.0.10"},
		{name: "same", status: 200, body: `{"tag_name":"v0.0.2"}`},
		{name: "older", status: 200, body: `{"tag_name":"v0.0.1"}`},
		{name: "draft", status: 200, body: `{"tag_name":"v0.0.3","draft":true}`},
		{name: "prerelease", status: 200, body: `{"tag_name":"v0.0.3-rc.1","prerelease":true}`},
		{name: "no releases", status: 404},
		{name: "rate limited", status: 403, fails: true},
		{name: "invalid response", status: 200, body: `{}`, fails: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.Header.Get("Accept") != "application/vnd.github+json" {
					t.Error("unexpected GitHub API request")
				}
				w.WriteHeader(tc.status)
				_, _ = fmt.Fprint(w, tc.body)
			}))
			t.Cleanup(server.Close)
			service := newReleaseUpdates("0.0.2")
			service.endpoint = server.URL
			result, err := service.Check(t.Context())
			if (err != nil) != tc.fails || result.Version != tc.want {
				t.Fatalf("Check() returned %+v, %v", result, err)
			}
			if tc.want != "" && result.URL != "https://github.com/zhanggc2019/RedisPal/releases/tag/"+tc.want {
				t.Fatalf("unexpected download URL: %s", result.URL)
			}
		})
	}
}

type updateTestHost struct{ updater.Host }

func (updateTestHost) Emit(string, ...any) bool { return false }

func TestSignedUpdatePreparation(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	const payload = "RedisPal test update"
	digest := sha256.Sum256([]byte(payload))
	signature := ed25519.Sign(privateKey, digest[:])
	invalidSignature := append([]byte(nil), signature...)
	invalidSignature[0] ^= 1

	for _, tc := range []struct {
		name      string
		payload   string
		signature []byte
		wantError string
	}{
		{"valid", payload, signature, ""},
		{"tampered", payload + "!", signature, "digest mismatch"},
		{"invalid signature", payload, invalidSignature, "signature did not verify"},
		{"unsigned", payload, nil, "must carry a signature"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var downloads atomic.Int32
			artifact := map[string]any{
				"url": "/app.exe", "platform": "windows", "arch": "amd64",
				"digestAlgo": "sha256", "digest": digest[:],
			}
			if tc.signature != nil {
				artifact["signatureAlgo"] = "ed25519"
				artifact["signature"] = tc.signature
			}
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/manifest.json":
					_ = json.NewEncoder(w).Encode(map[string]any{
						"schemaVersion": 1, "version": "0.0.2", "artifacts": []any{artifact},
					})
				case "/app.exe":
					downloads.Add(1)
					_, _ = fmt.Fprint(w, tc.payload)
				default:
					http.NotFound(w, r)
				}
			}))
			t.Cleanup(server.Close)
			provider, err := endpoint.New(endpoint.Config{URL: server.URL + "/manifest.json", HTTPClient: server.Client()})
			if err != nil {
				t.Fatal(err)
			}
			service := newReleaseUpdates("0.0.1")
			service.endpoint = server.URL + "/unused-github-feed"
			service.native = updater.New(updateTestHost{})
			if err := service.native.Init(updater.Config{
				CurrentVersion: "0.0.1", Providers: []updater.Provider{provider}, PublicKey: publicKey,
				Platform: "windows", Arch: "amd64", Window: updater.WindowNone,
			}); err != nil {
				t.Fatal(err)
			}
			if config := service.Configuration(); config.Version != "v0.0.1" || config.GitHub || !config.Signed || config.RepositoryURL != releaseRepositoryURL {
				t.Fatalf("unexpected configuration: %+v", config)
			}
			result, err := service.Check(t.Context())
			if err != nil || result.Version != "v0.0.2" || result.Ready || downloads.Load() != 0 {
				t.Fatalf("check returned %+v, %v after %d downloads", result, err, downloads.Load())
			}
			if err := service.PrepareUpdate(t.Context(), "v0.0.3"); err == nil || downloads.Load() != 0 {
				t.Fatal("prepared an update that was not checked")
			}
			err = service.PrepareUpdate(t.Context(), result.Version)
			if tc.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantError) {
					t.Fatalf("prepare returned %v, want %q", err, tc.wantError)
				}
				if err := service.RestartUpdate(t.Context()); err == nil {
					t.Fatal("restart allowed after verification failed")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			staged := service.native.DownloadedPath()
			if staged == "" {
				t.Fatal("verified update was not staged")
			}
			t.Cleanup(func() {
				if err := os.RemoveAll(filepath.Dir(staged)); err != nil {
					t.Error(err)
				}
			})
			result, err = service.Check(t.Context())
			if err != nil || !result.Ready || result.Version != "v0.0.2" {
				t.Fatalf("check after preparation returned %+v, %v", result, err)
			}
			if err := service.PrepareUpdate(t.Context(), result.Version); err != nil || downloads.Load() != 1 {
				t.Fatalf("repeat preparation returned %v after %d downloads", err, downloads.Load())
			}
		})
	}
}
