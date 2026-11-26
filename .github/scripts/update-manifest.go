package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

func main() {
	log.SetFlags(0)
	args := os.Args[1:]
	var err error
	switch {
	case len(args) == 2 && args[0] == "keygen":
		err = keygen(args[1])
	case (len(args) == 5 || len(args) == 6) && args[0] == "sign":
		var notesFile string
		if len(args) == 6 {
			notesFile = args[5]
		}
		err = sign(args[1], args[2], args[3], args[4], notesFile)
	default:
		err = errors.New("usage: update-manifest keygen PRIVATE_KEY_FILE | sign OWNER/REPO TAG EXE MANIFEST [NOTES_FILE]")
	}
	if err != nil {
		log.Fatal(err)
	}
}

func keygen(path string) error {
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = io.WriteString(file, base64.StdEncoding.EncodeToString(private.Seed()))
	if err = errors.Join(err, file.Close()); err != nil {
		return err
	}
	fmt.Println(base64.StdEncoding.EncodeToString(public))
	return nil
}

// sign records optional release notes alongside the verified update artifact metadata.
func sign(repo, tag, exe, destination, notesFile string) error {
	if !regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`).MatchString(repo) || !regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`).MatchString(tag) {
		return errors.New("expected a GitHub repository and a stable vX.Y.Z tag")
	}
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv("REDISPAL_UPDATE_PRIVATE_KEY")))
	if err != nil || len(seed) != ed25519.SeedSize {
		return errors.New("REDISPAL_UPDATE_PRIVATE_KEY must contain a base64 Ed25519 seed")
	}
	private := ed25519.NewKeyFromSeed(seed)
	public, err := base64.StdEncoding.DecodeString(os.Getenv("REDISPAL_UPDATE_PUBLIC_KEY"))
	if err != nil || !bytes.Equal(public, private.Public().(ed25519.PublicKey)) {
		return errors.New("REDISPAL_UPDATE_PUBLIC_KEY does not match the signing key")
	}
	file, err := os.Open(exe)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return err
	}
	if size == 0 || filepath.Base(exe) != "RedisPal-windows-x64.exe" {
		return errors.New("expected a nonempty RedisPal Windows x64 executable")
	}
	digest := hash.Sum(nil)
	manifest := map[string]any{
		"schemaVersion": 1,
		"version":       strings.TrimPrefix(tag, "v"),
		"artifacts": []map[string]any{{
			"url":           "https://github.com/" + repo + "/releases/download/" + tag + "/" + filepath.Base(exe),
			"filename":      filepath.Base(exe),
			"size":          size,
			"platform":      "windows",
			"arch":          "amd64",
			"digestAlgo":    "sha256",
			"digest":        digest,
			"signatureAlgo": "ed25519",
			"signature":     ed25519.Sign(private, digest),
		}},
	}
	if notesFile != "" {
		notes, err := os.ReadFile(notesFile)
		if err != nil {
			return err
		}
		manifest["notes"] = strings.TrimSpace(string(notes))
	}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(destination, append(encoded, '\n'), 0644)
}
