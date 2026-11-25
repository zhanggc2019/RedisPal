package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
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

// TestSignedUpdatesDisableGitHubDiscovery prevents double notifications in a custom signed build.
func TestSignedUpdatesDisableGitHubDiscovery(t *testing.T) {
	service := newReleaseUpdates("0.0.1")
	service.signed = true
	if configuration := service.Configuration(); configuration.Version != "v0.0.1" || configuration.GitHub {
		t.Fatalf("unexpected configuration: %+v", configuration)
	}
	if got := service.Configuration().RepositoryURL; got != "https://github.com/zhanggc2019/RedisPal" {
		t.Fatalf("unexpected repository URL: %q", got)
	}
	if result, err := service.Check(t.Context()); err != nil || result.Version != "" {
		t.Fatalf("signed build queried the default release feed: %+v, %v", result, err)
	}
}
