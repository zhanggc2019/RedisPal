package redisdesk

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Page is one bounded scan result and its opaque continuation.
type Page struct {
	Keys   []any  `json:"keys"`
	Cursor string `json:"cursor"`
}

// ServerInfo combines Redis INFO with the selectable logical databases.
type ServerInfo struct {
	Info      string `json:"info"`
	Databases []int  `json:"databases"`
	Size      int64  `json:"size"`
	Cluster   bool   `json:"cluster"`
}

// Backup preserves the exact Redis DUMP and an optional absolute expiry in milliseconds.
type Backup struct {
	Key       Argument `json:"key"`
	Dump      string   `json:"dump"`
	ExpiresAt int64    `json:"expiresAt"`
}

// BatchResult reports completed operations and individual failures.
type BatchResult struct {
	Imported int      `json:"imported"`
	Errors   []string `json:"errors"`
}

// MemoryEntry shows the sampled memory footprint of one Redis key.
type MemoryEntry struct {
	Key   any   `json:"key"`
	Bytes int64 `json:"bytes"`
}

type scanPosition struct {
	Node  int
	Redis uint64
}

// masters returns clients in deterministic order so scan cursors can advance across Cluster.
func masters(ctx context.Context, client redis.UniversalClient) ([]*redis.Client, error) {
	if single, ok := client.(*redis.Client); ok {
		return []*redis.Client{single}, nil
	}
	cluster := client.(*redis.ClusterClient)
	var clients []*redis.Client
	var mu sync.Mutex
	err := cluster.ForEachMaster(ctx, func(_ context.Context, node *redis.Client) error {
		mu.Lock()
		clients = append(clients, node)
		mu.Unlock()
		return nil
	})
	sort.Slice(clients, func(i, j int) bool { return clients[i].Options().Addr < clients[j].Options().Addr })
	return clients, err
}

// Scan looks up an exact key or performs one bounded SCAN step on one primary.
func (s *Service) Scan(ctx context.Context, id string, db int, pattern, cursor string, exact bool, count int) (Page, error) {
	page := Page{Keys: []any{}}
	client, _, err := s.client(id, db)
	if err != nil {
		return page, err
	}
	if exact {
		found, err := client.Exists(ctx, pattern).Result()
		if found > 0 {
			page.Keys = append(page.Keys, pattern)
		}
		return page, err
	}
	var position scanPosition
	if cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || json.Unmarshal(raw, &position) != nil || position.Node < 0 {
			return page, errors.New("invalid scan cursor")
		}
	}
	nodes, err := masters(ctx, client)
	if err != nil || position.Node >= len(nodes) {
		return page, err
	}
	if count == 0 {
		count = 400
	}
	count = min(10000, max(1, count))
	keys, next, err := nodes[position.Node].Scan(ctx, position.Redis, pattern, int64(count)).Result()
	if err != nil {
		return page, err
	}
	for _, key := range keys {
		page.Keys = append(page.Keys, wireString(key))
	}
	position.Redis = next
	if next == 0 {
		position.Node++
	}
	if position.Node < len(nodes) {
		raw, _ := json.Marshal(position)
		page.Cursor = base64.RawURLEncoding.EncodeToString(raw)
	}
	return page, nil
}

// Info reads Redis counters and discovers databases, with a fallback for restricted ACL users.
func (s *Service) Info(ctx context.Context, id string, db int) (ServerInfo, error) {
	info := ServerInfo{Databases: []int{0}}
	client, connection, err := s.client(id, db)
	if err != nil {
		return info, err
	}
	info.Cluster = connection.options.Mode == "cluster"
	nodes, err := masters(ctx, client)
	if err != nil {
		return info, err
	}
	for i, node := range nodes {
		if size, err := node.DBSize(ctx).Result(); err == nil {
			info.Size += size
		}
		if i == 0 {
			info.Info, err = node.Info(ctx).Result()
			if err != nil && !strings.Contains(err.Error(), "NOPERM") {
				return info, err
			}
		}
	}
	if !info.Cluster && len(nodes) > 0 {
		config, _ := nodes[0].ConfigGet(ctx, "databases").Result()
		n, _ := strconv.Atoi(config["databases"])
		if n > 0 && n <= 65536 {
			info.Databases = make([]int, n)
			for i := range info.Databases {
				info.Databases[i] = i
			}
		} else {
			for line := range strings.SplitSeq(info.Info, "\n") {
				if !strings.HasPrefix(line, "db") {
					continue
				}
				number, _, _ := strings.Cut(line[2:], ":")
				if value, err := strconv.Atoi(number); err == nil && value > 0 {
					info.Databases = append(info.Databases, value)
				}
			}
			sort.Ints(info.Databases)
			if len(info.Databases) == 1 && n == 0 && info.Info == "" {
				for i := 1; i < 16; i++ {
					info.Databases = append(info.Databases, i)
				}
			}
		}
	}
	return info, nil
}

// Export snapshots selected keys with DUMP and PTTL in the same transaction per key.
func (s *Service) Export(ctx context.Context, id string, db int, keys []Argument) ([]Backup, error) {
	client, _, err := s.client(id, db)
	if err != nil {
		return nil, err
	}
	entries := make([]Backup, 0, len(keys))
	for _, key := range keys {
		raw, err := key.raw()
		if err != nil {
			return nil, err
		}
		pipe := client.TxPipeline()
		dump := pipe.Dump(ctx, raw)
		ttl := pipe.PTTL(ctx, raw)
		_, err = pipe.Exec(ctx)
		if errors.Is(err, redis.Nil) {
			continue
		}
		if err != nil {
			return nil, err
		}
		entry := Backup{Key: key, Dump: hex.EncodeToString([]byte(dump.Val()))}
		if ttl.Val() >= 0 {
			entry.ExpiresAt = time.Now().Add(ttl.Val()).UnixMilli()
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// Import restores dump entries independently and reports key conflicts or malformed rows.
func (s *Service) Import(ctx context.Context, id string, db int, entries []Backup, replace bool) (BatchResult, error) {
	result := BatchResult{Errors: []string{}}
	client, connection, err := s.client(id, db)
	if err != nil {
		return result, err
	}
	if connection.options.ReadOnly {
		return result, errors.New("this connection is read-only")
	}
	for i, entry := range entries {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		key, keyErr := entry.Key.raw()
		dump, dumpErr := hex.DecodeString(entry.Dump)
		if keyErr != nil || dumpErr != nil || len(dump) == 0 {
			result.Errors = append(result.Errors, fmt.Sprintf("row %d: invalid hexadecimal key or dump", i+1))
			continue
		}
		var ttl time.Duration
		if entry.ExpiresAt > 0 {
			remaining := entry.ExpiresAt - time.Now().UnixMilli()
			if remaining <= 0 {
				result.Errors = append(result.Errors, fmt.Sprintf("row %d: entry has expired", i+1))
				continue
			}
			if remaining > int64((1<<63-1)/time.Millisecond) {
				result.Errors = append(result.Errors, fmt.Sprintf("row %d: expiry is out of range", i+1))
				continue
			}
			ttl = time.Duration(remaining) * time.Millisecond
		}
		var command *redis.StatusCmd
		if replace {
			command = client.RestoreReplace(ctx, key, ttl, string(dump))
		} else {
			command = client.Restore(ctx, key, ttl, string(dump))
		}
		if err := command.Err(); err != nil {
			result.Errors = append(result.Errors, fmt.Sprintf("row %d: %v", i+1, err))
			continue
		}
		result.Imported++
	}
	return result, nil
}

// Delete removes the explicitly selected keys, including keys in different Cluster slots.
func (s *Service) Delete(ctx context.Context, id string, db int, keys []Argument) (BatchResult, error) {
	result := BatchResult{Errors: []string{}}
	for i, key := range keys {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		value, err := s.command(ctx, id, db, []Argument{{Text: "DEL"}, key})
		if err != nil {
			result.Errors = append(result.Errors, fmt.Sprintf("key %d: %v", i+1, err))
			continue
		}
		result.Imported += int(value.(int64))
	}
	return result, nil
}

// Memory reports memory used by the keys in one scan page.
func (s *Service) Memory(ctx context.Context, id string, db int, keys []Argument) ([]MemoryEntry, error) {
	client, _, err := s.client(id, db)
	if err != nil {
		return nil, err
	}
	pipe := client.Pipeline()
	calls := make([]*redis.IntCmd, len(keys))
	for i, key := range keys {
		raw, err := key.raw()
		if err != nil {
			return nil, err
		}
		calls[i] = pipe.MemoryUsage(ctx, raw)
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	entries := make([]MemoryEntry, 0, len(keys))
	for i, call := range calls {
		switch err := call.Err(); {
		case err == nil:
			raw, _ := keys[i].raw()
			entries = append(entries, MemoryEntry{Key: wireString(raw), Bytes: call.Val()})
		case !errors.Is(err, redis.Nil):
			return nil, err
		}
	}
	return entries, nil
}

// Flush empties the selected database on all primaries, reporting any partial failure.
func (s *Service) Flush(ctx context.Context, id string, db int) error {
	client, connection, err := s.client(id, db)
	if err != nil {
		return err
	}
	if connection.options.ReadOnly {
		return errors.New("this connection is read-only")
	}
	nodes, err := masters(ctx, client)
	if err != nil {
		return err
	}
	if len(nodes) == 1 {
		_, err := s.command(ctx, id, db, []Argument{{Text: "FLUSHDB"}})
		return err
	}
	var failures []error
	for _, node := range nodes {
		if err := node.FlushDB(ctx).Err(); err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", node.Options().Addr, err))
		}
	}
	return errors.Join(failures...)
}
