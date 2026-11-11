// Package ids creates the core's random ids and tokens, using crypto/rand.
package ids

import (
	"crypto/rand"
	"encoding/hex"
)

// New returns a new random id of 16 hex digits (8 random bytes). The ids that the core stores
// (such as for config files) and the stats groups of reads have this form.
func New() string { return Hex(8) }

// Hex returns n random bytes in hex (2n digits).
func Hex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b) // crypto/rand's Read never fails
	return hex.EncodeToString(b)
}
