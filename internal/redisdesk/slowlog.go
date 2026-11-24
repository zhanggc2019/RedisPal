package redisdesk

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// SlowLogNodes lists the primary nodes whose Redis slow logs can be inspected.
func (s *Service) SlowLogNodes(ctx context.Context, id string, db int) ([]string, error) {
	client, _, err := s.client(id, db)
	if err != nil {
		return nil, err
	}
	nodes, err := masters(ctx, client)
	if err != nil {
		return nil, err
	}
	addresses := make([]string, len(nodes))
	for i, node := range nodes {
		addresses[i] = node.Options().Addr
	}
	return addresses, nil
}

// slowLogClient pins both inspection and configuration to the selected primary.
func (s *Service) slowLogClient(ctx context.Context, id string, db int, address string, write bool) (*redis.Client, error) {
	client, connection, err := s.client(id, db)
	if err != nil {
		return nil, err
	}
	if write && connection.options.ReadOnly {
		return nil, errors.New("this connection is read-only")
	}
	nodes, err := masters(ctx, client)
	if err != nil {
		return nil, err
	}
	for _, node := range nodes {
		if address == "" || node.Options().Addr == address {
			return node, nil
		}
	}
	return nil, errors.New("Redis primary is unavailable")
}

// SlowLogEntries reads the current slow log from the selected primary.
func (s *Service) SlowLogEntries(ctx context.Context, id string, db int, address string, count int) (Reply, error) {
	node, err := s.slowLogClient(ctx, id, db, address, false)
	if err != nil {
		return Reply{}, err
	}
	start := time.Now()
	result, err := node.Do(ctx, "SLOWLOG", "GET", min(10000, max(1, count))).Result()
	s.recordCommand(id, db, "SLOWLOG", start, err)
	return Reply{Value: wireReply(result)}, err
}

// SlowLogSettings reads the slow log threshold and retained entry count.
func (s *Service) SlowLogSettings(ctx context.Context, id string, db int, address string) (map[string]string, error) {
	node, err := s.slowLogClient(ctx, id, db, address, false)
	if err != nil {
		return nil, err
	}
	return node.ConfigGet(ctx, "slowlog-*").Result()
}

// SetSlowLogSetting applies one live Redis setting on the selected primary.
func (s *Service) SetSlowLogSetting(ctx context.Context, id string, db int, address, name string, value int64) error {
	switch name {
	case "slowlog-log-slower-than":
		if value < -1 {
			return errors.New("the slow log threshold must be at least -1")
		}
	case "slowlog-max-len":
		if value < 0 {
			return errors.New("the slow log length cannot be negative")
		}
	default:
		return errors.New("unknown slow log setting")
	}
	node, err := s.slowLogClient(ctx, id, db, address, true)
	if err != nil {
		return err
	}
	return node.ConfigSet(ctx, name, strconv.FormatInt(value, 10)).Err()
}

// ResetSlowLog clears the slow log only on the explicitly selected primary.
func (s *Service) ResetSlowLog(ctx context.Context, id string, db int, address string) error {
	node, err := s.slowLogClient(ctx, id, db, address, true)
	if err != nil {
		return err
	}
	start := time.Now()
	err = node.Do(ctx, "SLOWLOG", "RESET").Err()
	s.recordCommand(id, db, "SLOWLOG", start, err)
	return err
}
