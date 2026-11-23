package redisdesk

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// bridge closes both halves of a test TCP/SSH proxy when either direction ends.
func bridge(first, second io.ReadWriteCloser) {
	defer first.Close()
	defer second.Close()
	go func() {
		_, _ = io.Copy(first, second)
		_ = first.Close()
	}()
	_, _ = io.Copy(second, first)
}

// testCertificate creates an ephemeral CA for a TLS transport test on loopback.
func testCertificate(t *testing.T) (tls.Certificate, string) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	spec := &x509.Certificate{
		Subject: pkix.Name{CommonName: "Redis fixture"}, DNSNames: []string{"redis.fixture"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		BasicConstraintsValid: true, IsCA: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, spec, spec, public, private)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "redis-fixture-ca.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: private}, path
}

// acceptLoop serves each ephemeral fixture connection until the test closes its listener.
func acceptLoop(t *testing.T, listener net.Listener, handler func(net.Conn)) string {
	t.Helper()
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go handler(conn)
		}
	}()
	return listener.Addr().String()
}

// TestRedisTLS checks certificate trust, SNI, rejection and Redis authentication through TLS.
func TestRedisTLS(t *testing.T) {
	target := os.Getenv("REDIS_TEST_ADDR")
	if target == "" {
		t.Skip("set REDIS_TEST_ADDR to run the TLS proxy integration test")
	}
	cert, ca := testCertificate(t)
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	addr := acceptLoop(t, listener, func(in net.Conn) {
		defer in.Close()
		out, err := net.DialTimeout("tcp", target, time.Second)
		if err == nil {
			bridge(in, out)
		}
	})
	service := NewService()
	defer service.close()
	options := Connection{Addr: addr, Password: os.Getenv("REDIS_TEST_PASSWORD"), TLS: true, TLSCA: ca, TLSServerName: "redis.fixture"}
	if err := service.Connect(t.Context(), "tls", options); err != nil {
		t.Fatal(err)
	}
	if got := runStrings(t, service, "tls", 0, "PING"); got != "PONG" {
		t.Fatalf("unexpected PING reply: %v", got)
	}
	options.TLSServerName = "unexpected.fixture"
	if err := service.Test(t.Context(), options); err == nil {
		t.Fatal("mismatched TLS hostname accepted")
	}
}

// TestRedisSSH checks a password-authenticated SSH forwarding channel and known_hosts verification.
func TestRedisSSH(t *testing.T) {
	target := os.Getenv("REDIS_TEST_ADDR")
	if target == "" {
		t.Skip("set REDIS_TEST_ADDR to run the SSH proxy integration test")
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{PasswordCallback: func(info ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
		if info.User() != "fixture" || string(password) != "fixture-password" {
			return nil, fmt.Errorf("SSH authentication failed")
		}
		return nil, nil
	}}
	config.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := acceptLoop(t, listener, func(raw net.Conn) {
		defer raw.Close()
		conn, channels, requests, err := ssh.NewServerConn(raw, config)
		if err != nil {
			return
		}
		defer conn.Close()
		go ssh.DiscardRequests(requests)
		for offer := range channels {
			if offer.ChannelType() != "direct-tcpip" {
				_ = offer.Reject(ssh.UnknownChannelType, "unsupported channel")
				continue
			}
			out, err := net.DialTimeout("tcp", target, time.Second)
			if err != nil {
				_ = offer.Reject(ssh.ConnectionFailed, err.Error())
				continue
			}
			channel, requests, err := offer.Accept()
			if err != nil {
				_ = out.Close()
				continue
			}
			go ssh.DiscardRequests(requests)
			go bridge(channel, out)
		}
	})
	path := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(path, []byte(knownhosts.Line([]string{addr}, signer.PublicKey())+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	options := Connection{
		Addr: target, Password: os.Getenv("REDIS_TEST_PASSWORD"), SSH: true, SSHAddr: addr,
		SSHUsername: "fixture", SSHPassword: "fixture-password", SSHKnownHosts: path,
	}
	service := NewService()
	defer service.close()
	if err := service.Connect(t.Context(), "ssh", options); err != nil {
		t.Fatal(err)
	}
	if got := runStrings(t, service, "ssh", 0, "PING"); got != "PONG" {
		t.Fatalf("unexpected PING reply: %v", got)
	}
	options.SSHPassword = "invalid"
	if err := service.Test(context.Background(), options); err == nil {
		t.Fatal("invalid SSH password accepted")
	}
}

// TestSSHDeadline ensures a stalled forwarded connection returns a normal timeout.
func TestSSHDeadline(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	conn := &sshDeadlineConn{Conn: left}
	_ = conn.SetDeadline(time.Now().Add(-time.Second))
	if _, err := conn.Write([]byte{1}); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("expired write: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	if _, err := conn.Read(make([]byte, 1)); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("blocked read: %v", err)
	}
}
