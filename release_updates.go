package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
	"golang.org/x/mod/semver"
)

const (
	releaseRepository    = "zhanggc2019/RedisPal"
	releaseRepositoryURL = "https://github.com/" + releaseRepository
)

//go:embed release-notes/*.md
var bundledReleaseNotes embed.FS

// ReleaseConfiguration describes the current build and whether it follows GitHub Releases.
type ReleaseConfiguration struct {
	Version       string `json:"version"`
	GitHub        bool   `json:"github"`
	Signed        bool   `json:"signed"`
	RepositoryURL string `json:"repositoryUrl"`
	Notes         string `json:"notes,omitempty"`
}

// ReleaseUpdate describes a newer stable release and its official download page.
type ReleaseUpdate struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	Ready   bool   `json:"ready"`
	Notes   string `json:"notes,omitempty"`
}

// ReleaseUpdates coordinates version checks and user-initiated updates.
type ReleaseUpdates struct {
	version  string
	endpoint string
	client   *http.Client
	native   *updater.Updater
	mu       sync.Mutex
	pending  ReleaseUpdate
}

// newReleaseUpdates pins the default feed to RedisPal's GitHub repository.
func newReleaseUpdates(version string) *ReleaseUpdates {
	return &ReleaseUpdates{
		version:  "v" + strings.TrimPrefix(version, "v"),
		endpoint: "https://api.github.com/repos/" + releaseRepository + "/releases/latest",
		client:   &http.Client{Timeout: 8 * time.Second},
	}
}

// Configuration returns the build version and its bundled release notes offline.
func (s *ReleaseUpdates) Configuration() ReleaseConfiguration {
	notes, _ := bundledReleaseNotes.ReadFile("release-notes/" + s.version + ".md")
	return ReleaseConfiguration{
		Version:       s.version,
		GitHub:        s.native == nil && s.endpoint != "",
		Signed:        s.native != nil,
		RepositoryURL: releaseRepositoryURL,
		Notes:         strings.TrimSpace(string(notes)),
	}
}

// Check discovers updates without downloading an executable.
func (s *ReleaseUpdates) Check(ctx context.Context) (ReleaseUpdate, error) {
	if s.native != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.pending.Ready {
			return s.pending, nil
		}
		s.pending = ReleaseUpdate{}
		release, err := s.native.Check(ctx)
		if err != nil || release == nil {
			return ReleaseUpdate{}, err
		}
		version := "v" + strings.TrimPrefix(release.Version, "v")
		if !semver.IsValid(version) || semver.Prerelease(version) != "" || semver.Compare(version, s.version) <= 0 {
			return ReleaseUpdate{}, nil
		}
		s.pending = ReleaseUpdate{Version: version, Notes: strings.TrimSpace(release.Notes)}
		return s.pending, nil
	}
	var update ReleaseUpdate
	if s.endpoint == "" {
		return update, nil
	}
	if !semver.IsValid(s.version) {
		return update, errors.New("invalid application version")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.endpoint, nil)
	if err != nil {
		return update, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "RedisPal/"+s.version)
	response, err := s.client.Do(request)
	if err != nil {
		return update, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return update, nil
	}
	if response.StatusCode != http.StatusOK {
		return update, fmt.Errorf("GitHub Releases HTTP %d", response.StatusCode)
	}

	var release struct {
		Tag        string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
		Notes      string `json:"body"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&release); err != nil {
		return update, err
	}
	if !semver.IsValid(release.Tag) {
		return update, errors.New("invalid GitHub release version")
	}
	if release.Draft || release.Prerelease || semver.Prerelease(release.Tag) != "" || semver.Compare(release.Tag, s.version) <= 0 {
		return update, nil
	}
	return ReleaseUpdate{
		Version: release.Tag,
		URL:     releaseRepositoryURL + "/releases/tag/" + url.PathEscape(release.Tag),
		Notes:   strings.TrimSpace(release.Notes),
	}, nil
}

// PrepareUpdate downloads and verifies the exact version last offered to the user.
func (s *ReleaseUpdates) PrepareUpdate(ctx context.Context, version string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.native == nil || version == "" || version != s.pending.Version {
		return errors.New("check for this update again before installing")
	}
	if s.pending.Ready {
		return nil
	}
	if err := s.native.DownloadAndInstall(ctx); err != nil {
		return err
	}
	s.pending.Ready = true
	return nil
}

// RestartUpdate applies the verified update after the user confirms the restart.
func (s *ReleaseUpdates) RestartUpdate(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.native == nil || !s.pending.Ready {
		return errors.New("no verified update is ready")
	}
	return s.native.Restart(ctx)
}
