package redisdesk

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// FeedMessage is a single Pub/Sub or MONITOR event.
type FeedMessage struct {
	Time    string `json:"time"`
	Channel string `json:"channel,omitempty"`
	Value   any    `json:"value"`
}

// FeedBatch is the next set of events and any terminal error.
type FeedBatch struct {
	Messages []FeedMessage `json:"messages"`
	Error    string        `json:"error"`
	Dropped  int           `json:"dropped"`
}

type feed struct {
	session string
	cancel  context.CancelFunc
	mu      sync.Mutex
	ring    [500]FeedMessage
	start   int
	count   int
	dropped int
	err     string
}

// push appends to a bounded event queue without blocking Redis.
func (f *feed) push(channel string, value any) {
	item := FeedMessage{Time: time.Now().Format(time.RFC3339Nano), Channel: channel, Value: value}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ring[(f.start+f.count)%len(f.ring)] = item
	if f.count < len(f.ring) {
		f.count++
	} else {
		f.start = (f.start + 1) % len(f.ring)
		f.dropped++
	}
}

// StartFeed subscribes a CLI tab to Redis Pub/Sub or MONITOR until it is stopped.
func (s *Service) StartFeed(ctx context.Context, id string, db int, token, mode string, args []string) error {
	client, connection, err := s.client(id, db)
	if err != nil {
		return err
	}
	var run func()
	feedCtx, cancel := context.WithCancel(context.Background())
	stream := &feed{session: id, cancel: cancel}
	switch strings.ToLower(mode) {
	case "subscribe", "psubscribe", "ssubscribe":
		if len(args) == 0 {
			cancel()
			return errors.New("a channel or pattern is required")
		}
		var sub *redis.PubSub
		switch strings.ToLower(mode) {
		case "psubscribe":
			sub = client.PSubscribe(ctx, args...)
		case "ssubscribe":
			sub = client.SSubscribe(ctx, args...)
		default:
			sub = client.Subscribe(ctx, args...)
		}
		if _, err := sub.Receive(ctx); err != nil {
			_ = sub.Close()
			cancel()
			return err
		}
		run = func() {
			defer sub.Close()
			for {
				select {
				case <-feedCtx.Done():
					return
				case message, ok := <-sub.Channel():
					if !ok {
						return
					}
					stream.push(message.Channel, wireString(message.Payload))
				}
			}
		}
	case "monitor":
		if connection.options.ReadOnly {
			cancel()
			return errors.New("MONITOR is unavailable for read-only connections")
		}
		nodes, err := masters(ctx, client)
		if err != nil || len(nodes) == 0 {
			cancel()
			return errors.New("no Redis primary available for MONITOR")
		}
		socket, reader, err := monitorSocket(ctx, nodes[0].Options())
		if err != nil {
			cancel()
			return err
		}
		run = func() {
			defer socket.Close()
			stop := context.AfterFunc(feedCtx, func() { _ = socket.Close() })
			defer stop()
			for {
				line, err := reader.ReadString('\n')
				if err != nil {
					if feedCtx.Err() == nil {
						stream.mu.Lock()
						stream.err = err.Error()
						stream.mu.Unlock()
					}
					return
				}
				stream.push("", strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(line, "+"), "\n"), "\r"))
			}
		}
	default:
		cancel()
		return errors.New("unknown Redis feed")
	}
	s.mu.Lock()
	if s.sessions[id] != connection {
		s.mu.Unlock()
		cancel()
		// The worker owns the opened socket or subscription and will release it.
		go run()
		return errors.New("connection changed before the feed started")
	}
	old := s.feeds[token]
	s.feeds[token] = stream
	s.mu.Unlock()
	if old != nil {
		old.cancel()
	}
	go run()
	return nil
}

// monitorSocket opens a dedicated Redis socket so MONITOR cannot leave a pooled connection in streaming mode.
func monitorSocket(ctx context.Context, options *redis.Options) (net.Conn, *bufio.Reader, error) {
	dial := options.Dialer
	if dial == nil {
		dial = redis.NewDialer(options)
	}
	socket, err := dial(ctx, options.Network, options.Addr)
	if err != nil {
		return nil, nil, err
	}
	_ = socket.SetDeadline(time.Now().Add(10 * time.Second))
	reader := bufio.NewReader(socket)
	if options.Password != "" {
		args := []string{"AUTH", options.Password}
		if options.Username != "" {
			args = []string{"AUTH", options.Username, options.Password}
		}
		err = monitorHandshake(socket, reader, args...)
	}
	if err == nil && options.DB != 0 {
		err = monitorHandshake(socket, reader, "SELECT", strconv.Itoa(options.DB))
	}
	if err == nil {
		err = monitorHandshake(socket, reader, "MONITOR")
	}
	if err != nil {
		_ = socket.Close()
		return nil, nil, err
	}
	_ = socket.SetDeadline(time.Time{})
	return socket, reader, nil
}

// monitorHandshake sends one RESP command and consumes its OK or error status.
func monitorHandshake(socket net.Conn, reader *bufio.Reader, args ...string) error {
	var data strings.Builder
	fmt.Fprintf(&data, "*%d\r\n", len(args))
	for _, arg := range args {
		fmt.Fprintf(&data, "$%d\r\n%s\r\n", len(arg), arg)
	}
	if _, err := socket.Write([]byte(data.String())); err != nil {
		return err
	}
	line, err := reader.ReadString('\n')
	if err == nil && line != "+OK\r\n" {
		err = errors.New(strings.TrimSpace(line))
	}
	return err
}

// PollFeed drains events collected since the last request.
func (s *Service) PollFeed(token string) FeedBatch {
	result := FeedBatch{Messages: []FeedMessage{}}
	s.mu.RLock()
	stream := s.feeds[token]
	s.mu.RUnlock()
	if stream == nil {
		return result
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	for i := 0; i < stream.count; i++ {
		index := (stream.start + i) % len(stream.ring)
		result.Messages = append(result.Messages, stream.ring[index])
		stream.ring[index] = FeedMessage{}
	}
	result.Error, result.Dropped = stream.err, stream.dropped
	stream.start, stream.count, stream.dropped = 0, 0, 0
	return result
}

// StopFeed releases an individual Pub/Sub or MONITOR connection.
func (s *Service) StopFeed(token string) {
	s.mu.Lock()
	stream := s.feeds[token]
	delete(s.feeds, token)
	s.mu.Unlock()
	if stream != nil {
		stream.cancel()
	}
}
