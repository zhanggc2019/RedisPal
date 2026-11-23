package redisdesk

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// Connection describes a saved Redis endpoint and its optional transports.
type Connection struct {
	Addr             string `json:"addr"`
	Username         string `json:"username"`
	Password         string `json:"password"`
	Mode             string `json:"mode"`
	SentinelMaster   string `json:"sentinelMaster"`
	SentinelUsername string `json:"sentinelUsername"`
	SentinelPassword string `json:"sentinelPassword"`
	ReadOnly         bool   `json:"readOnly"`
	TLS              bool   `json:"tls"`
	TLSCA            string `json:"tlsCA"`
	TLSCert          string `json:"tlsCert"`
	TLSKey           string `json:"tlsKey"`
	TLSServerName    string `json:"tlsServerName"`
	SSH              bool   `json:"ssh"`
	SSHAddr          string `json:"sshAddr"`
	SSHUsername      string `json:"sshUsername"`
	SSHPassword      string `json:"sshPassword"`
	SSHKey           string `json:"sshKey"`
	SSHPassphrase    string `json:"sshPassphrase"`
	SSHKnownHosts    string `json:"sshKnownHosts"`
	SSHTimeout       int    `json:"sshTimeout"`
}

type session struct {
	options   Connection
	addresses []string
	tls       *tls.Config
	ssh       *ssh.Client
	mu        sync.Mutex
	clients   map[int]redis.UniversalClient
	closed    bool
}

// openSession validates an endpoint and authenticates its first database client.
func openSession(ctx context.Context, options Connection) (*session, error) {
	addresses := strings.FieldsFunc(options.Addr, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' })
	if len(addresses) == 0 {
		return nil, errors.New("Redis address is required")
	}
	for _, address := range addresses {
		if _, _, err := net.SplitHostPort(address); err != nil {
			return nil, fmt.Errorf("invalid Redis address %q: %w", address, err)
		}
	}
	switch options.Mode {
	case "", "standalone", "cluster":
	case "sentinel":
		if strings.TrimSpace(options.SentinelMaster) == "" {
			return nil, errors.New("Sentinel master name is required")
		}
	default:
		return nil, errors.New("unknown connection mode")
	}
	if len(addresses) > 1 && (options.Mode == "" || options.Mode == "standalone") {
		return nil, errors.New("standalone mode accepts one Redis address")
	}
	s := &session{options: options, addresses: addresses, clients: make(map[int]redis.UniversalClient)}
	var err error
	if options.TLS {
		s.tls, err = tlsConfig(options)
		if err != nil {
			return nil, err
		}
	}
	if options.SSH {
		s.ssh, err = openSSH(ctx, options)
		if err != nil {
			return nil, err
		}
	}
	client, err := s.client(0)
	if err == nil {
		err = client.Ping(ctx).Err()
	}
	if err != nil {
		s.close()
		return nil, err
	}
	return s, nil
}

// tlsConfig loads an optional CA and client certificate from disk.
func tlsConfig(options Connection) (*tls.Config, error) {
	config := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: options.TLSServerName}
	if options.TLSCA != "" {
		pem, err := os.ReadFile(options.TLSCA)
		if err != nil {
			return nil, err
		}
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("TLS CA file contains no PEM certificates")
		}
		config.RootCAs = pool
	}
	if options.TLSCert != "" || options.TLSKey != "" {
		cert, err := tls.LoadX509KeyPair(options.TLSCert, options.TLSKey)
		if err != nil {
			return nil, err
		}
		config.Certificates = []tls.Certificate{cert}
	}
	return config, nil
}

// openSSH authenticates a tunnel and verifies the server against known_hosts.
func openSSH(ctx context.Context, options Connection) (*ssh.Client, error) {
	path := options.SSHKnownHosts
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		path = filepath.Join(home, ".ssh", "known_hosts")
	}
	verify, err := knownhosts.New(path)
	if err != nil {
		return nil, fmt.Errorf("SSH known_hosts: %w", err)
	}
	config := &ssh.ClientConfig{User: options.SSHUsername, HostKeyCallback: verify}
	if options.SSHKey != "" {
		data, err := os.ReadFile(options.SSHKey)
		if err != nil {
			return nil, err
		}
		var key ssh.Signer
		if options.SSHPassphrase == "" {
			key, err = ssh.ParsePrivateKey(data)
		} else {
			key, err = ssh.ParsePrivateKeyWithPassphrase(data, []byte(options.SSHPassphrase))
		}
		if err != nil {
			return nil, err
		}
		config.Auth = append(config.Auth, ssh.PublicKeys(key))
	}
	if options.SSHPassword != "" {
		config.Auth = append(config.Auth, ssh.Password(options.SSHPassword))
	}
	timeout := time.Duration(options.SSHTimeout) * time.Second
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "tcp", options.SSHAddr)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	if value, ok := ctx.Deadline(); ok && value.Before(deadline) {
		deadline = value
	}
	_ = conn.SetDeadline(deadline)
	clientConn, channels, requests, err := ssh.NewClientConn(conn, options.SSHAddr, config)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return ssh.NewClient(clientConn, channels, requests), nil
}

// dialThroughSSH lets Cluster and Sentinel reach the addresses announced by Redis.
func (s *session) dialThroughSSH(ctx context.Context, network, addr string) (net.Conn, error) {
	conn, err := s.ssh.DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	conn = &sshDeadlineConn{Conn: conn}
	if s.tls == nil {
		return conn, nil
	}
	config := s.tls.Clone()
	if config.ServerName == "" {
		config.ServerName, _, _ = net.SplitHostPort(addr)
	}
	tlsConn := tls.Client(conn, config)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return tlsConn, nil
}

// sshDeadlineConn adapts SSH forwarded channels, which do not implement socket deadlines.
// Redis sets each deadline before starting an operation. A timed-out channel is discarded by its pool.
type sshDeadlineConn struct {
	net.Conn
	mu          sync.Mutex
	read, write time.Time
}

// SetDeadline applies a deadline to subsequent Redis reads and writes.
func (c *sshDeadlineConn) SetDeadline(deadline time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.read, c.write = deadline, deadline
	return nil
}

// SetReadDeadline applies a deadline to subsequent Redis reads.
func (c *sshDeadlineConn) SetReadDeadline(deadline time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.read = deadline
	return nil
}

// SetWriteDeadline applies a deadline to subsequent Redis writes.
func (c *sshDeadlineConn) SetWriteDeadline(deadline time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.write = deadline
	return nil
}

// Read enforces the response deadline on an SSH channel.
func (c *sshDeadlineConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	deadline := c.read
	c.mu.Unlock()
	return c.timed(deadline, c.Conn.Read, p)
}

// Write enforces the command deadline on an SSH channel.
func (c *sshDeadlineConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	deadline := c.write
	c.mu.Unlock()
	return c.timed(deadline, c.Conn.Write, p)
}

// timed closes a blocked channel at the deadline so Redis can discard it and reconnect.
func (c *sshDeadlineConn) timed(deadline time.Time, operation func([]byte) (int, error), buffer []byte) (int, error) {
	if deadline.IsZero() {
		return operation(buffer)
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return 0, os.ErrDeadlineExceeded
	}
	timer := time.AfterFunc(remaining, func() { _ = c.Conn.Close() })
	n, err := operation(buffer)
	if !timer.Stop() {
		err = os.ErrDeadlineExceeded
	}
	return n, err
}

// client returns a pooled connection for one logical database without issuing SELECT on shared sockets.
func (s *session) client(db int) (redis.UniversalClient, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if db < 0 || db > 65535 || (s.options.Mode == "cluster" && db != 0) {
		return nil, errors.New("invalid database for this connection")
	}
	if s.closed {
		return nil, errors.New("connection has been closed")
	}
	if client := s.clients[db]; client != nil {
		return client, nil
	}
	options := &redis.UniversalOptions{
		Addrs: s.addresses, DB: db, Username: s.options.Username, Password: s.options.Password,
		Protocol: 2, TLSConfig: s.tls, IsClusterMode: s.options.Mode == "cluster",
		DialTimeout: 6 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second,
		ContextTimeoutEnabled: true, MaxRetries: -1, DisableIdentity: true,
	}
	if s.ssh != nil {
		options.Dialer = s.dialThroughSSH
	}
	if s.options.Mode == "sentinel" {
		options.MasterName = s.options.SentinelMaster
		options.SentinelUsername = s.options.SentinelUsername
		options.SentinelPassword = s.options.SentinelPassword
	}
	client := redis.NewUniversalClient(options)
	s.clients[db] = client
	return client, nil
}

// close releases both Redis pools and their shared SSH transport.
func (s *session) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for _, client := range s.clients {
		_ = client.Close()
	}
	if s.ssh != nil {
		_ = s.ssh.Close()
	}
}
