package remotes

import (
	"sync"
	"time"
)

// claimTTL is how long a claim lasts without a release. It is long enough for a sign-in on
// another device, and short enough that a page which went away doesn't block the prompt until
// the next restart.
const claimTTL = 15 * time.Minute

// Claims gives each remote's reconnect dialog to one tab at a time. Claims are kept only in
// memory, so they are lost when the process ends.
type Claims struct {
	s  *Service
	mu sync.Mutex
	m  map[string]claim
}

type claim struct {
	holder string
	at     time.Time
}

func newClaims(s *Service) *Claims { return &Claims{s: s, m: map[string]claim{}} }

// Claim gives name's dialog to holder, which is whatever the caller uses to identify a tab. It
// refuses when someone else holds a claim that is younger than claimTTL. When holder claims
// again, its claim is renewed.
func (c *Claims) Claim(name, holder string) Claim {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.s.now()
	if cur, ok := c.m[name]; ok && cur.holder != holder && now.Sub(cur.at) < claimTTL {
		return Claim{Holder: cur.holder}
	}
	c.m[name] = claim{holder: holder, at: now}
	return Claim{Granted: true}
}

// Release gives up name's dialog. Only its holder can release it.
func (c *Claims) Release(name, holder string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if cur, ok := c.m[name]; ok && cur.holder == holder {
		delete(c.m, name)
	}
}
