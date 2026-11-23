package redisdesk

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/redis/go-redis/v9"
)

// runStrings calls the same command bridge as an interactive Redis tab.
func runStrings(t *testing.T, service *Service, id string, db int, args ...string) any {
	t.Helper()
	params := make([]Argument, len(args))
	for i, arg := range args {
		params[i] = Argument{Text: arg}
	}
	reply, err := service.Command(t.Context(), id, db, params)
	if err != nil {
		t.Fatalf("%s: %v", args[0], err)
	}
	return reply.Value
}

// waitForFeed checks streaming results without relying on fixed network timing.
func waitForFeed(t *testing.T, service *Service, token, expected string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		result := service.PollFeed(token)
		if result.Error != "" {
			t.Fatal(result.Error)
		}
		for _, line := range result.Messages {
			if text, ok := line.Value.(string); ok && strings.Contains(text, expected) {
				return
			}
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("no %s event for the test key", token)
}

// TestRedisTools integrates Pub/Sub, MONITOR, log history, memory analysis and batch deletion.
func TestRedisTools(t *testing.T) {
	addr := os.Getenv("REDIS_TEST_ADDR")
	if addr == "" {
		t.Skip("set REDIS_TEST_ADDR to run Redis integration tests")
	}
	service := NewService()
	defer service.close()
	ctx := t.Context()
	options := Connection{Addr: addr, Password: os.Getenv("REDIS_TEST_PASSWORD")}
	if err := service.Connect(ctx, "tools", options); err != nil {
		t.Fatal(err)
	}
	key := fmt.Sprintf("ardm-wails-tools:%d", time.Now().UnixNano())
	defer runStrings(t, service, "tools", 0, "DEL", key)
	runStrings(t, service, "tools", 0, "SET", key, "payload", "EX", "120")
	for _, mode := range []string{"SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "MONITOR"} {
		t.Run(mode, func(t *testing.T) {
			args := []string{key}
			if mode == "PSUBSCRIBE" {
				args[0] += "*"
			}
			if err := service.StartFeed(ctx, "tools", 0, mode, mode, args); err != nil {
				if mode == "SSUBSCRIBE" && strings.Contains(err.Error(), "unknown command") {
					t.Skip("SSUBSCRIBE requires Redis 7")
				}
				t.Fatal(err)
			}
			defer service.StopFeed(mode)
			switch mode {
			case "MONITOR":
				runStrings(t, service, "tools", 0, "GET", key)
				waitForFeed(t, service, mode, key)
			case "SSUBSCRIBE":
				runStrings(t, service, "tools", 0, "SPUBLISH", key, key)
				waitForFeed(t, service, mode, key)
			default:
				runStrings(t, service, "tools", 0, "PUBLISH", key, key)
				waitForFeed(t, service, mode, key)
			}
		})
	}

	memory, err := service.Memory(ctx, "tools", 0, []Argument{{Text: key}, {Text: key + ":missing"}})
	if err != nil || len(memory) != 1 || memory[0].Bytes < 1 {
		t.Fatalf("memory: %+v %v", memory, err)
	}
	if entries := service.Logs(); len(entries) < 2 || entries[0].Command == "" {
		t.Fatalf("log length/outcome: %d", len(entries))
	}
	service.ClearLogs()
	if len(service.Logs()) != 0 {
		t.Fatal("log not cleared")
	}
	_ = runStrings(t, service, "tools", 0, "SLOWLOG", "GET", "1")
	result, err := service.Delete(ctx, "tools", 0, []Argument{{Text: key}, {Hex: "invalid"}, {Text: key + ":missing"}})
	if err != nil || result.Imported != 1 || len(result.Errors) != 1 {
		t.Fatalf("delete: %+v %v", result, err)
	}
}

// TestRedisTopologies exercises real optional Cluster and Sentinel instances.
func TestRedisTopologies(t *testing.T) {
	for _, item := range []struct{ mode, env string }{{"cluster", "REDIS_TEST_CLUSTER"}, {"sentinel", "REDIS_TEST_SENTINEL"}} {
		t.Run(item.mode, func(t *testing.T) {
			addr := os.Getenv(item.env)
			if addr == "" {
				t.Skip("set " + item.env + " to run topology tests")
			}
			service := NewService()
			defer service.close()
			ctx := t.Context()
			options := Connection{Addr: addr, Mode: item.mode, SentinelMaster: "ardm"}
			if err := service.Connect(ctx, item.mode, options); err != nil {
				t.Fatal(err)
			}
			db := 0
			if item.mode == "sentinel" {
				db = 2
			}
			key := fmt.Sprintf("ardm-wails-topology:%d", time.Now().UnixNano())
			defer runStrings(t, service, item.mode, db, "DEL", key)
			runStrings(t, service, item.mode, db, "SET", key, "redis", "EX", "120")
			info, err := service.Info(ctx, item.mode, db)
			if err != nil || info.Size < 1 || info.Cluster != (item.mode == "cluster") {
				t.Fatalf("info: size=%d cluster=%v %v", info.Size, info.Cluster, err)
			}
			page, err := service.Scan(ctx, item.mode, db, key, "", false, 1000)
			if err != nil || len(page.Keys) != 1 {
				t.Fatalf("scan: %+v %v", page, err)
			}
			backup, err := service.Export(ctx, item.mode, db, []Argument{{Text: key}})
			if err != nil || len(backup) != 1 {
				t.Fatalf("export: %+v %v", backup, err)
			}
			runStrings(t, service, item.mode, db, "DEL", key)
			if result, err := service.Import(ctx, item.mode, db, backup, true); err != nil || result.Imported != 1 {
				t.Fatalf("restore: %+v %v", result, err)
			}
			if item.mode == "cluster" {
				if _, _, err := service.client(item.mode, 1); err == nil {
					t.Fatal("cluster selected nonzero database")
				}
			} else if got := runStrings(t, service, item.mode, 0, "GET", key); got != nil {
				t.Fatal("database 2 key also appeared in database 0")
			}
		})
	}
}

// TestInputAndLaunch covers validation of untrusted values before reaching Redis.
func TestInputAndLaunch(t *testing.T) {
	service := NewService()
	t.Cleanup(func() { _ = service.ServiceShutdown() })
	for _, connection := range []Connection{
		{}, {Addr: "missing-port"}, {Addr: "localhost:6379", Mode: "unknown"}, {Addr: "localhost:26379", Mode: "sentinel"},
		{Addr: "localhost:6379,localhost:6380"}, {Addr: "localhost:6379", TLS: true, TLSCA: filepath.Join(t.TempDir(), "missing.pem")},
		{Addr: "localhost:6379", SSH: true, SSHKnownHosts: filepath.Join(t.TempDir(), "missing-known-hosts")},
	} {
		if err := service.Test(t.Context(), connection); err == nil {
			t.Errorf("accepted invalid options: %+v", connection)
		}
	}
	if err := service.Connect(t.Context(), "", Connection{}); err == nil {
		t.Fatal("accepted empty session ID")
	}
	if _, err := service.Command(t.Context(), "missing", 0, nil); err == nil {
		t.Fatal("accepted empty command")
	}
	if got := wireReply([]any{int64(9223372036854775807), "ok", string([]byte{0xff})}).([]any); got[0] != "9223372036854775807" || got[2] != (Argument{Hex: "ff"}) {
		t.Fatalf("incorrect Redis reply: %#v", got)
	}
	raw := []string{"--host", "::1", "--sentinel-master-name", "ardm", "--sentinel-node-password", "node", "--auth", "sentinel", "--ssh-host", "localhost", "--ssh-username", "test", "--ssl", "--save"}
	launch, err := ParseLaunchProfile(raw)
	if err != nil || launch.Connection.Addr != "[::1]:6379" || launch.Connection.Mode != "sentinel" ||
		launch.Connection.Password != "node" || launch.Connection.SentinelPassword != "sentinel" || !launch.Connection.TLS || !launch.Connection.SSH || !launch.Save {
		t.Fatalf("incorrect startup options: %+v %v", launch, err)
	}
	launchService := NewService(launch)
	if launchService.Startup() != launch || launchService.Startup() != nil {
		t.Fatal("startup options were not consumed once")
	}
	if launch, err := ParseLaunchProfile(nil); launch != nil || err != nil {
		t.Fatal("unexpected default startup profile")
	}
	if _, err := ParseLaunchProfile([]string{"--unknown"}); err == nil {
		t.Fatal("unknown flag accepted")
	}
}

// TestDecodeRoundTrip validates the exact bytes of all supported compression formats.
func TestDecodeRoundTrip(t *testing.T) {
	service := NewService()
	value := []byte{0, 2, 255, 127, 33}
	for name, wrap := range map[string]func(io.Writer) io.WriteCloser{
		"Gzip":    func(w io.Writer) io.WriteCloser { return gzip.NewWriter(w) },
		"Brotli":  func(w io.Writer) io.WriteCloser { return brotli.NewWriter(w) },
		"Deflate": func(w io.Writer) io.WriteCloser { return zlib.NewWriter(w) },
		"DeflateRaw": func(w io.Writer) io.WriteCloser {
			writer, _ := flate.NewWriter(w, flate.DefaultCompression)
			return writer
		},
	} {
		t.Run(name, func(t *testing.T) {
			var data bytes.Buffer
			writer := wrap(&data)
			if _, err := writer.Write(value); err != nil {
				t.Fatal(err)
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			got, err := service.Decode(name, Argument{Hex: hex.EncodeToString(data.Bytes())})
			if err != nil || got != (Argument{Hex: hex.EncodeToString(value)}) {
				t.Fatalf("decode: %#v %v", got, err)
			}
		})
	}
	for _, item := range []struct{ mode, hex string }{{"Gzip", "Hi"}, {"Deflate", "00"}, {"Unknown", "01"}, {"Gzip", "00"}, {"DeflateRaw", "00"}, {"Brotli", "00"}} {
		if _, err := service.Decode(item.mode, Argument{Hex: item.hex}); err == nil {
			t.Errorf("%s accepted invalid data", item.mode)
		}
	}
}

// TestFeedRing verifies ordering and dropped-message accounting at its retention limit.
func TestFeedRing(t *testing.T) {
	service := NewService()
	service.feeds["test"] = &feed{cancel: func() {}}
	for i := range 503 {
		service.feeds["test"].push("fixture", i)
	}
	result := service.PollFeed("test")
	if len(result.Messages) != 500 || result.Dropped != 3 || result.Messages[0].Value != 3 || result.Messages[499].Value != 502 {
		t.Fatal("feed backlog was not drained in order")
	}
	if len(service.PollFeed("test").Messages) != 0 {
		t.Fatal("drained messages appeared again")
	}
	service.StopFeed("test")
}

// TestMonitorHandshake reports a Redis server error without leaking credentials.
func TestMonitorHandshake(t *testing.T) {
	client, server := net.Pipe()
	defer server.Close()
	go func() {
		buf := make([]byte, 256)
		_, _ = server.Read(buf)
		_, _ = io.WriteString(server, "-ERR MONITOR denied\r\n")
	}()
	options := &redis.Options{Dialer: func(context.Context, string, string) (net.Conn, error) { return client, nil }}
	if _, _, err := monitorSocket(t.Context(), options); err == nil || !strings.Contains(err.Error(), "MONITOR denied") {
		t.Fatalf("expected server error, got %v", err)
	}
}

// TestCommandValidation checks malformed requests, expired backups and pool state isolation.
func TestCommandValidation(t *testing.T) {
	addr := os.Getenv("REDIS_TEST_ADDR")
	if addr == "" {
		t.Skip("set REDIS_TEST_ADDR to run the Redis validation test")
	}
	ctx := t.Context()
	service := NewService()
	defer service.close()
	options := Connection{Addr: addr, Password: os.Getenv("REDIS_TEST_PASSWORD")}
	if err := service.Connect(ctx, "validation", options); err != nil {
		t.Fatal(err)
	}
	key := fmt.Sprintf("ardm-wails-validation:%d", time.Now().UnixNano())
	runStrings(t, service, "validation", 0, "SET", key, "test", "EX", "120")
	defer runStrings(t, service, "validation", 0, "DEL", key)
	for _, command := range [][]Argument{
		{{Text: "SELECT"}, {Text: "1"}}, {{Text: "CLIENT"}, {Text: "REPLY"}, {Text: "OFF"}},
		{{Text: "SET"}, {Hex: "you can't decode this"}}, {{Text: "NONEXISTENT_COMMAND"}},
	} {
		if _, err := service.Command(ctx, "validation", 0, command); err == nil {
			t.Fatalf("accepted invalid command %s", command[0].Text)
		}
	}
	if _, err := service.Scan(ctx, "validation", 0, "*", "invalid-token", false, 0); err == nil {
		t.Fatal("accepted invalid cursor")
	}
	if _, err := service.Info(ctx, "validation", -1); err == nil {
		t.Fatal("accepted invalid database")
	}
	if _, err := service.Export(ctx, "validation", 0, []Argument{{Hex: "not-hex"}}); err == nil {
		t.Fatal("accepted invalid backup key")
	}
	if rows, err := service.Export(ctx, "validation", 0, []Argument{{Text: key + "missing"}}); err != nil || len(rows) != 0 {
		t.Fatalf("export missing key: %+v %v", rows, err)
	}
	if result, err := service.Import(ctx, "validation", 0, []Backup{
		{Key: Argument{Text: key}, Dump: "01", ExpiresAt: 1},
		{Key: Argument{Text: key}, Dump: "not-hex"},
		{Key: Argument{Text: key}, Dump: "ff", ExpiresAt: 1<<63 - 1},
	}, true); err != nil || len(result.Errors) != 3 || result.Imported != 0 {
		t.Fatalf("invalid backup rows: %+v %v", result, err)
	}
	if err := service.StartFeed(ctx, "validation", 0, "feed", "UNKNOWN", nil); err == nil {
		t.Fatal("invalid stream mode accepted")
	}
	if err := service.StartFeed(ctx, "validation", 0, "feed", "SUBSCRIBE", nil); err == nil {
		t.Fatal("missing channel accepted")
	}
	options.ReadOnly = true
	if err := service.Connect(ctx, "readonly", options); err != nil {
		t.Fatal(err)
	}
	if err := service.StartFeed(ctx, "readonly", 0, "feed", "MONITOR", nil); err == nil {
		t.Fatal("read-only MONITOR accepted")
	}
	if _, err := service.Import(ctx, "readonly", 0, nil, true); err == nil {
		t.Fatal("read-only restore accepted")
	}
	if err := service.Flush(ctx, "readonly", 0); err == nil {
		t.Fatal("read-only flush accepted")
	}
	if got := runStrings(t, service, "validation", 0, "GET", key); got != "test" {
		t.Fatal("validation changed the test key")
	}
}

// TestFormatterChild supplies a test executable without relying on a platform shell.
func TestFormatterChild(t *testing.T) {
	if os.Getenv("ARDM_FORMAT_TEST_CHILD") != "1" {
		return
	}
	value, err := io.ReadAll(os.Stdin)
	if err != nil {
		os.Exit(1)
	}
	fmt.Fprintf(os.Stdout, "%s|%s", value, os.Args[len(os.Args)-1])
	os.Exit(0)
}

// TestCustomFormatter verifies byte transport, placeholder expansion and process errors.
func TestCustomFormatter(t *testing.T) {
	service := NewService()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ARDM_FORMAT_TEST_CHILD", "1")
	arg := []string{"-test.run=^TestFormatterChild$", "--", "{HEX}"}
	output, err := service.FormatWith(t.Context(), executable, arg, Argument{Text: "test"})
	if err != nil || output != "test|74657374" {
		t.Fatalf("formatter: %#v %v", output, err)
	}
	if _, err := service.FormatWith(t.Context(), filepath.Join(t.TempDir(), "does-not-exist"), nil, Argument{}); err == nil {
		t.Fatal("missing formatter accepted")
	}
	if _, err := service.FormatWith(t.Context(), executable, nil, Argument{Hex: "invalid"}); err == nil {
		t.Fatal("invalid binary input accepted")
	}
	var outputLimit boundedOutput
	if _, err := outputLimit.Write(make([]byte, formatLimit+1)); err == nil {
		t.Fatal("oversized formatter result accepted")
	}
}
