package redisdesk

import (
	"flag"
	"io"
	"net"
	"strings"
)

// LaunchProfile is a Redis connection passed to the desktop executable on startup.
type LaunchProfile struct {
	Connection Connection `json:"connection"`
	Name       string     `json:"name"`
	Separator  string     `json:"separator"`
	Save       bool       `json:"save"`
}

// ParseLaunchProfile accepts the original Electron application's connection flags.
func ParseLaunchProfile(args []string) (*LaunchProfile, error) {
	set := flag.NewFlagSet("RedisPal", flag.ContinueOnError)
	set.SetOutput(io.Discard)
	profile := &LaunchProfile{}
	options := &profile.Connection
	host := set.String("host", "", "Redis hostname")
	port := set.String("port", "6379", "Redis port")
	auth := set.String("auth", "", "Redis or Sentinel password")
	cluster := set.Bool("cluster", false, "Redis Cluster mode")
	sshHost := set.String("ssh-host", "", "SSH server hostname")
	sshPort := set.String("ssh-port", "22", "SSH server port")
	set.StringVar(&profile.Name, "name", "", "Connection name")
	set.StringVar(&profile.Separator, "separator", ":", "Key tree separator")
	set.BoolVar(&profile.Save, "save", false, "Persist the connection")
	set.BoolVar(&options.ReadOnly, "readonly", false, "Open read-only")
	set.StringVar(&options.Username, "username", "", "Redis username")
	set.StringVar(&options.SSHUsername, "ssh-username", "", "SSH username")
	set.StringVar(&options.SSHPassword, "ssh-password", "", "SSH password")
	set.StringVar(&options.SSHKey, "ssh-private-key", "", "SSH private key")
	set.StringVar(&options.SSHPassphrase, "ssh-passphrase", "", "SSH private key passphrase")
	set.StringVar(&options.SSHKnownHosts, "ssh-known-hosts", "", "SSH host key database")
	set.IntVar(&options.SSHTimeout, "ssh-timeout", 10, "SSH timeout in seconds")
	set.StringVar(&options.SentinelMaster, "sentinel-master-name", "", "Sentinel master group")
	set.StringVar(&options.SentinelUsername, "sentinel-username", "", "Sentinel username")
	set.StringVar(&options.Password, "sentinel-node-password", "", "Redis password in Sentinel mode")
	set.BoolVar(&options.TLS, "ssl", false, "Enable Redis TLS")
	set.StringVar(&options.TLSCA, "ssl-ca", "", "Redis CA certificate")
	set.StringVar(&options.TLSCert, "ssl-cert", "", "Redis client certificate")
	set.StringVar(&options.TLSKey, "ssl-key", "", "Redis TLS private key")
	set.StringVar(&options.TLSServerName, "ssl-servername", "", "Redis TLS server name")
	if err := set.Parse(args); err != nil {
		return nil, err
	}
	if *host == "" {
		return nil, nil
	}
	options.Addr = net.JoinHostPort(strings.Trim(*host, "[]"), *port)
	options.Mode = "standalone"
	if options.SentinelMaster != "" {
		options.Mode = "sentinel"
		options.SentinelPassword = *auth
	} else {
		options.Password = *auth
		if *cluster {
			options.Mode = "cluster"
		}
	}
	if *sshHost != "" && options.SSHUsername != "" {
		options.SSH = true
		options.SSHAddr = net.JoinHostPort(strings.Trim(*sshHost, "[]"), *sshPort)
	}
	return profile, nil
}

// Startup returns the one-time connection supplied on the command line.
func (s *Service) Startup() *LaunchProfile {
	s.mu.Lock()
	defer s.mu.Unlock()
	profile := s.startup
	s.startup = nil
	return profile
}
