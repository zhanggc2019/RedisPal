package redisdesk

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// TestRedisWorkflow exercises the same service methods used by the desktop UI.
func TestRedisWorkflow(t *testing.T) {
	addr := os.Getenv("REDIS_TEST_ADDR")
	if addr == "" {
		t.Skip("set REDIS_TEST_ADDR to run Redis integration tests")
	}
	ctx := context.Background()
	password := os.Getenv("REDIS_TEST_PASSWORD")
	connection := Connection{Addr: addr, Password: password}
	service := NewService()
	defer service.close()
	bad := connection
	bad.Password += "-incorrect"
	if err := service.Test(ctx, bad); err == nil {
		t.Fatal("wrong password accepted")
	}
	if err := service.Test(ctx, connection); err != nil {
		t.Fatal(err)
	}
	if err := service.Connect(ctx, "test", connection); err != nil {
		t.Fatal(err)
	}
	prefix := fmt.Sprintf("ardm-wails-test:%d:", time.Now().UnixNano())
	cleanup := redis.NewClient(&redis.Options{Addr: addr, Password: password})
	defer cleanup.Close()
	names := []string{prefix + "string", prefix + "hash", prefix + "list", prefix + "set", prefix + "zset", prefix + "stream", prefix + "restored", prefix + "binary", prefix + "renamed"}
	defer cleanup.Del(ctx, names...)
	run := func(args ...string) any {
		t.Helper()
		input := make([]Argument, len(args))
		for i, value := range args {
			input[i] = Argument{Text: value}
		}
		got, err := service.Command(ctx, "test", 0, input)
		if err != nil {
			t.Fatalf("%s: %v", args[0], err)
		}
		return got.Value
	}
	run("SET", names[0], "初始值", "EX", "300")
	run("HSET", names[1], "field", "value")
	run("RPUSH", names[2], "one", "two")
	run("SADD", names[3], "member")
	run("ZADD", names[4], "1.25", "member")
	run("XADD", names[5], "*", "field", "value")
	run("XGROUP", "CREATE", names[5], "test", "0")
	if got := run("GET", names[0]); got != "初始值" {
		t.Fatalf("GET: %#v", got)
	}
	for i, kind := range []string{"string", "hash", "list", "set", "zset", "stream"} {
		if got := run("TYPE", names[i]); got != kind {
			t.Fatalf("TYPE %s: %#v", kind, got)
		}
	}
	page, err := service.Scan(ctx, "test", 0, prefix+"*", "", false, 10000)
	if err != nil {
		t.Fatalf("scan: %+v %v", page, err)
	}
	matches := make(map[any]bool)
	for {
		for _, key := range page.Keys {
			matches[key] = true
		}
		if page.Cursor == "" {
			break
		}
		page, err = service.Scan(ctx, "test", 0, prefix+"*", page.Cursor, false, 10000)
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(matches) != 6 {
		t.Fatalf("scan matches: %d", len(matches))
	}
	exact, err := service.Scan(ctx, "test", 0, names[1], "", true, 0)
	if err != nil || len(exact.Keys) != 1 || exact.Keys[0] != names[1] {
		t.Fatalf("exact lookup: %+v %v", exact, err)
	}
	entries, err := service.Export(ctx, "test", 0, []Argument{{Text: names[0]}})
	if err != nil || len(entries) != 1 || entries[0].ExpiresAt == 0 {
		t.Fatalf("export: %+v %v", entries, err)
	}
	run("RENAMENX", names[0], names[8])
	entries[0].Key = Argument{Text: names[6]}
	if result, err := service.Import(ctx, "test", 0, entries, false); err != nil || result.Imported != 1 {
		t.Fatalf("import: %+v %v", result, err)
	}
	if result, err := service.Import(ctx, "test", 0, entries, false); err != nil || len(result.Errors) != 1 {
		t.Fatalf("import conflict: %+v %v", result, err)
	}
	if got := run("GET", names[6]); got != "初始值" {
		t.Fatalf("restored GET: %#v", got)
	}
	if _, err := service.Command(ctx, "test", 0, []Argument{{Text: "SET"}, {Text: names[7]}, {Hex: "ff0041"}}); err != nil {
		t.Fatal(err)
	}
	if got := run("GET", names[7]); got != (Argument{Hex: "ff0041"}) {
		t.Fatalf("binary value: %#v", got)
	}
	info, err := service.Info(ctx, "test", 0)
	if err != nil || info.Info == "" || len(info.Databases) == 0 {
		t.Fatalf("INFO: %+v %v", info, err)
	}
	connection.ReadOnly = true
	if err := service.Connect(ctx, "readonly", connection); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Command(ctx, "readonly", 0, []Argument{{Text: "SET"}, {Text: names[0]}, {Text: "unexpected"}}); err == nil {
		t.Fatal("read-only write accepted")
	}
	if _, err := service.Command(ctx, "readonly", 0, []Argument{{Text: "GET"}, {Text: names[6]}}); err != nil {
		t.Fatal(err)
	}
	service.Disconnect("test")
	if _, err := service.Info(ctx, "test", 0); err == nil {
		t.Fatal("closed connection accepted")
	}
}

// TestReadOnlyPolicy covers subcommands which have both read and write forms.
func TestReadOnlyPolicy(t *testing.T) {
	for _, args := range [][]string{{"CONFIG", "SET"}, {"CLIENT", "PAUSE"}, {"SLOWLOG", "RESET"}, {"ACL", "SETUSER"}, {"EVAL", "return 1"}, {"SET"}} {
		if readOnlyCommand(args) {
			t.Errorf("accepted %v", args)
		}
	}
	for _, args := range [][]string{{"get"}, {"CONFIG", "GET"}, {"SLOWLOG", "GET"}, {"XINFO", "GROUPS"}, {"TS.RANGE"}} {
		if !readOnlyCommand(args) {
			t.Errorf("rejected %v", args)
		}
	}
}
