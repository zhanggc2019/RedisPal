package redisdesk

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/hex"
	"errors"
	"io"
	"os/exec"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
)

const formatLimit = 16 << 20

// Decode unpacks a compressed value and limits the decoded output to the editor's capacity.
func (s *Service) Decode(format string, value Argument) (any, error) {
	raw, err := value.raw()
	if err != nil {
		return nil, err
	}
	input := strings.NewReader(raw)
	var reader io.Reader
	switch format {
	case "Brotli":
		reader = brotli.NewReader(input)
	case "Gzip":
		reader, err = gzip.NewReader(input)
	case "Deflate":
		reader, err = zlib.NewReader(input)
	case "DeflateRaw":
		reader = flate.NewReader(input)
	default:
		return nil, errors.New("unknown compression format")
	}
	if err != nil {
		return nil, err
	}
	if reader, ok := reader.(io.Closer); ok {
		defer reader.Close()
	}
	plain, err := io.ReadAll(io.LimitReader(reader, formatLimit+1))
	if len(plain) > formatLimit {
		return nil, errors.New("decoded value exceeds 16 MiB")
	}
	return wireString(string(plain)), err
}

type boundedOutput struct{ bytes.Buffer }

// Write stops collecting output if a custom formatter exceeds the editor limit.
func (b *boundedOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > formatLimit {
		return 0, errors.New("formatter output exceeds 16 MiB")
	}
	return b.Buffer.Write(p)
}

// FormatWith runs a user-selected executable directly, keeping Redis bytes out of shell parsing.
func (s *Service) FormatWith(ctx context.Context, executable string, args []string, value Argument) (any, error) {
	raw, err := value.raw()
	if err != nil {
		return nil, err
	}
	for i, argument := range args {
		switch argument {
		case "{VALUE}":
			args[i] = raw
		case "{HEX}":
			args[i] = hex.EncodeToString([]byte(raw))
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Stdin = strings.NewReader(raw)
	var output boundedOutput
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Run(); err != nil {
		if output.Len() != 0 {
			return nil, errors.New(output.String())
		}
		return nil, err
	}
	return wireString(output.String()), nil
}
