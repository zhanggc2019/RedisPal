package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/mod/semver"
)

const (
	releaseRepository    = "zhanggc2019/RedisPal"
	releaseRepositoryURL = "https://github.com/" + releaseRepository
)

// ReleaseConfiguration describes the current build and whether it follows GitHub Releases.
type ReleaseConfiguration struct {
	Version       string `json:"version"`
	GitHub        bool   `json:"github"`
	RepositoryURL string `json:"repositoryUrl"`
}

// ReleaseUpdate describes a newer stable release and its official download page.
type ReleaseUpdate struct {
	Version string `json:"version"`
	URL     string `json:"url"`
}

// ReleaseUpdates exposes version checks to the workspace without downloading or running binaries.
type ReleaseUpdates struct {
	version  string
	endpoint string
	client   *http.Client
	signed   bool
}

// newReleaseUpdates pins the default feed to RedisPal's GitHub repository.
func newReleaseUpdates(version string) *ReleaseUpdates {
	return &ReleaseUpdates{
		version:  "v" + strings.TrimPrefix(version, "v"),
		endpoint: "https://api.github.com/repos/" + releaseRepository + "/releases/latest",
		client:   &http.Client{Timeout: 8 * time.Second},
	}
}

// Configuration returns immediately so Settings can display the version offline.
func (s *ReleaseUpdates) Configuration() ReleaseConfiguration {
	return ReleaseConfiguration{
		Version:       s.version,
		GitHub:        !s.signed && s.endpoint != "",
		RepositoryURL: releaseRepositoryURL,
	}
}

// Check finds a newer stable GitHub release and constructs its official release URL.
func (s *ReleaseUpdates) Check(ctx context.Context) (ReleaseUpdate, error) {
	var update ReleaseUpdate
	if !s.Configuration().GitHub {
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
	}, nil
}
