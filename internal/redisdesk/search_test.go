package redisdesk

import "testing"

// TestReadOnlySearchCommands keeps query access independent from index writes.
func TestReadOnlySearchCommands(t *testing.T) {
	for _, command := range []string{"FT._LIST", "FT.INFO", "FT.SEARCH", "FT.AGGREGATE", "FT.EXPLAIN", "FT.PROFILE"} {
		if !readOnlyCommand([]string{command}) {
			t.Errorf("%s should be available on read-only connections", command)
		}
	}
	for _, command := range []string{"FT.CREATE", "FT.ALTER", "FT.DROPINDEX"} {
		if readOnlyCommand([]string{command}) {
			t.Errorf("%s writes to Redis and should be rejected on read-only connections", command)
		}
	}
}
