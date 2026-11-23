package redisdesk

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/redis/go-redis/v9"
)

// Argument transfers text or exact bytes through Wails JSON bindings.
type Argument struct {
	Text string `json:"text,omitempty"`
	Hex  string `json:"hex,omitempty"`
}

// Reply keeps Redis nil distinct from the transport's empty response.
type Reply struct {
	Value any `json:"value"`
}

// LogEntry is one duration and outcome in the local command history.
type LogEntry struct {
	Time      string `json:"time"`
	Session   string `json:"session"`
	Database  int    `json:"database"`
	Command   string `json:"command"`
	ElapsedMS int64  `json:"elapsedMs"`
	Error     string `json:"error,omitempty"`
}

// Service owns live Redis sessions, command history, and streaming subscriptions.
type Service struct {
	mu       sync.RWMutex
	sessions map[string]*session
	logs     []LogEntry
	feeds    map[string]*feed
	startup  *LaunchProfile
}

// NewService makes an independent service for a desktop window or test.
func NewService(startup ...*LaunchProfile) *Service {
	service := &Service{sessions: make(map[string]*session), feeds: make(map[string]*feed)}
	if len(startup) > 0 {
		service.startup = startup[0]
	}
	return service
}

// ServiceShutdown closes Redis and streaming clients when the desktop process exits.
func (s *Service) ServiceShutdown() error {
	s.close()
	return nil
}

// close releases active resources without holding the service lock during network calls.
func (s *Service) close() {
	s.mu.Lock()
	sessions := s.sessions
	feeds := s.feeds
	s.sessions = make(map[string]*session)
	s.feeds = make(map[string]*feed)
	s.mu.Unlock()
	for _, stream := range feeds {
		stream.cancel()
	}
	for _, connection := range sessions {
		connection.close()
	}
}

// Test authenticates an endpoint without leaving a live session behind.
func (s *Service) Test(ctx context.Context, options Connection) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	connection, err := openSession(ctx, options)
	if err == nil {
		connection.close()
	}
	return err
}

// Connect replaces a session only after the new endpoint has authenticated successfully.
func (s *Service) Connect(ctx context.Context, id string, options Connection) error {
	if id == "" {
		return errors.New("connection ID is required")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	connection, err := openSession(ctx, options)
	if err != nil {
		return err
	}
	s.mu.Lock()
	old := s.sessions[id]
	s.sessions[id] = connection
	for token, stream := range s.feeds {
		if stream.session == id {
			stream.cancel()
			delete(s.feeds, token)
		}
	}
	s.mu.Unlock()
	if old != nil {
		old.close()
	}
	return nil
}

// Disconnect releases the connection and all streams it owns.
func (s *Service) Disconnect(id string) {
	s.mu.Lock()
	connection := s.sessions[id]
	delete(s.sessions, id)
	for token, stream := range s.feeds {
		if stream.session == id {
			stream.cancel()
			delete(s.feeds, token)
		}
	}
	s.mu.Unlock()
	if connection != nil {
		connection.close()
	}
}

// client resolves a session and logical database for a frontend operation.
func (s *Service) client(id string, db int) (redis.UniversalClient, *session, error) {
	s.mu.RLock()
	connection := s.sessions[id]
	s.mu.RUnlock()
	if connection == nil {
		return nil, nil, errors.New("connection is closed")
	}
	client, err := connection.client(db)
	return client, connection, err
}

// raw decodes one binary-safe argument before it crosses the Redis connection.
func (a Argument) raw() (string, error) {
	if a.Hex == "" {
		return a.Text, nil
	}
	bytes, err := hex.DecodeString(a.Hex)
	return string(bytes), err
}

// wireString keeps text readable and preserves invalid UTF-8 byte for byte.
func wireString(value string) any {
	if utf8.ValidString(value) {
		return value
	}
	return Argument{Hex: hex.EncodeToString([]byte(value))}
}

// wireReply converts nested RESP arrays and protects integers beyond JavaScript precision.
func wireReply(value any) any {
	switch item := value.(type) {
	case string:
		return wireString(item)
	case int64:
		if item < -9007199254740991 || item > 9007199254740991 {
			return fmt.Sprint(item)
		}
	case []any:
		for i := range item {
			item[i] = wireReply(item[i])
		}
	}
	return value
}

// readOnlyCommand allows known read commands and checks mixed-purpose command subcommands.
func readOnlyCommand(args []string) bool {
	if len(args) == 0 {
		return false
	}
	command := strings.ToUpper(args[0])
	switch command {
	case "PING", "ECHO", "TIME", "INFO", "DBSIZE", "COMMAND", "ROLE", "TYPE", "EXISTS", "TTL", "PTTL", "EXPIRETIME", "PEXPIRETIME",
		"SCAN", "KEYS", "RANDOMKEY", "DUMP", "GET", "MGET", "STRLEN", "GETRANGE", "GETBIT", "BITCOUNT", "BITPOS",
		"HGET", "HMGET", "HGETALL", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSTRLEN", "HSCAN", "HTTL", "HPTTL", "HEXPIRETIME", "HPEXPIRETIME", "HRANDFIELD",
		"LRANGE", "LINDEX", "LLEN", "LPOS", "SCARD", "SMEMBERS", "SISMEMBER", "SMISMEMBER", "SRANDMEMBER", "SDIFF", "SINTER", "SUNION", "SSCAN",
		"ZSCAN", "ZCARD", "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "ZRANGEBYLEX", "ZCOUNT", "ZSCORE", "ZMSCORE", "ZRANK", "ZREVRANK", "ZRANDMEMBER",
		"XLEN", "XRANGE", "XREVRANGE", "XPENDING", "XREAD", "JSON.GET", "JSON.MGET", "JSON.TYPE", "JSON.OBJKEYS", "JSON.OBJLEN", "JSON.ARRLEN",
		"TS.INFO", "TS.GET", "TS.RANGE", "TS.REVRANGE", "VINFO", "VCARD", "VDIM", "VRANGE", "VRANDMEMBER", "VEMB", "VGETATTR", "VSIM",
		"ARINFO", "ARLEN", "ARCOUNT", "ARGET", "ARMGET", "ARRANGE", "ARSCAN", "ARGREP", "SUBSCRIBE", "PSUBSCRIBE":
		return true
	}
	if len(args) < 2 {
		return false
	}
	sub := strings.ToUpper(args[1])
	switch command {
	case "CONFIG":
		return sub == "GET"
	case "XINFO":
		return slices.Contains([]string{"STREAM", "GROUPS", "CONSUMERS"}, sub)
	case "SLOWLOG":
		return sub == "GET" || sub == "LEN"
	case "MEMORY":
		return slices.Contains([]string{"USAGE", "STATS", "DOCTOR"}, sub)
	case "CLIENT":
		return slices.Contains([]string{"INFO", "LIST", "ID", "GETNAME"}, sub)
	case "ACL":
		return slices.Contains([]string{"LIST", "USERS", "CAT", "WHOAMI", "GETUSER"}, sub) || (sub == "LOG" && (len(args) == 2 || !strings.EqualFold(args[2], "RESET")))
	case "CLUSTER":
		return slices.Contains([]string{"INFO", "NODES", "SLOTS", "SHARDS", "KEYSLOT", "REPLICAS"}, sub)
	case "LATENCY":
		return slices.Contains([]string{"DOCTOR", "LATEST", "HISTORY", "GRAPH", "HISTOGRAM"}, sub)
	}
	return false
}

// Command executes one binary-safe Redis command using the selected connection and database.
func (s *Service) Command(ctx context.Context, id string, db int, input []Argument) (Reply, error) {
	value, err := s.command(ctx, id, db, input)
	return Reply{Value: value}, err
}

// command executes and records a Redis command, independent of its transport envelope.
func (s *Service) command(ctx context.Context, id string, db int, input []Argument) (any, error) {
	if len(input) == 0 {
		return nil, errors.New("Redis command is empty")
	}
	client, connection, err := s.client(id, db)
	if err != nil {
		return nil, err
	}
	args := make([]string, len(input))
	values := make([]any, len(input))
	for i, arg := range input {
		args[i], err = arg.raw()
		if err != nil {
			return nil, fmt.Errorf("argument %d: %w", i+1, err)
		}
		values[i] = args[i]
	}
	command := strings.ToUpper(args[0])
	switch command {
	case "SELECT", "AUTH", "HELLO", "QUIT", "RESET", "WATCH", "UNWATCH", "MULTI", "EXEC", "DISCARD", "MONITOR",
		"SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "UNSUBSCRIBE", "PUNSUBSCRIBE", "SUNSUBSCRIBE":
		return nil, errors.New("use the database selector or the CLI subscription/monitor panel for connection-scoped commands")
	case "CLIENT":
		if len(args) > 1 && slices.Contains([]string{"REPLY", "TRACKING", "CACHING", "SETNAME", "SETINFO", "NO-EVICT", "NO-TOUCH"}, strings.ToUpper(args[1])) {
			return nil, errors.New("command changes state on a shared connection")
		}
	}
	if connection.options.ReadOnly && !readOnlyCommand(args) {
		return nil, errors.New("this connection is read-only")
	}
	start := time.Now()
	result, err := client.Do(ctx, values...).Result()
	if errors.Is(err, redis.Nil) {
		err = nil
	}
	entry := LogEntry{Time: start.Format(time.RFC3339Nano), Session: id, Database: db, Command: command, ElapsedMS: time.Since(start).Milliseconds()}
	if err != nil {
		entry.Error = err.Error()
	}
	s.mu.Lock()
	if len(s.logs) == 1000 {
		copy(s.logs, s.logs[1:])
		s.logs = s.logs[:999]
	}
	s.logs = append(s.logs, entry)
	s.mu.Unlock()
	return wireReply(result), err
}

// Logs returns recent commands with newest first and excludes argument values.
func (s *Service) Logs() []LogEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	logs := append([]LogEntry{}, s.logs...)
	slices.Reverse(logs)
	return logs
}

// ClearLogs resets the local command history.
func (s *Service) ClearLogs() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logs = nil
}
