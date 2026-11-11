package engine

import (
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/app/launcher/match"
)

// How much the history counts. Each past pick adds a little, a recent pick adds more, and a pick
// made after the same query adds more again. Recent results are listed first for an empty
// query.
const (
	usePerPick      = 2
	usePicksCounted = 10
	recentMinPicks  = 2
	recentWithin    = 30 * 24 * time.Hour
	recentMax       = 5
	recentBoost     = 1_000_000 // puts a recent result before every default one
	sameQueryBoost  = 20
	maxResults      = 50
)

func recency(last, now time.Time) int {
	switch age := now.Sub(last); {
	case age < 24*time.Hour:
		return 30
	case age < 3*24*time.Hour:
		return 20
	case age < 7*24*time.Hour:
		return 10
	case age < recentWithin:
		return 3
	}
	return 0
}

func boost(u Use, query string, now time.Time) int {
	if u.Count == 0 {
		return 0
	}
	b := min(u.Count, usePicksCounted)*usePerPick + recency(u.Last, now)
	query = normalizeQuery(query)
	for _, q := range u.Queries {
		if query != "" && normalizeQuery(q) == query {
			b += sameQueryBoost
			break
		}
	}
	return b
}

func normalizeQuery(q string) string { return strings.Join(strings.Fields(strings.ToLower(q)), " ") }

// of returns no history for a result with no key (Quit), even if something is stored under "".
func (u Usage) of(key string) Use {
	if key == "" {
		return Use{}
	}
	return u[key]
}

func isRecent(u Use, now time.Time) bool {
	return u.Count >= recentMinPicks && now.Sub(u.Last) < recentWithin
}

// Rank filters and orders results for q. When words are typed, each result must match them in
// its title or a keyword (unless Always is set). The match counts most, and a match in the title
// beats one in a keyword. The user's history comes next, then how much of the title the match
// covers. The provider's score only breaks ties, except when paths are typed, where it ranks
// what can be done with them. An empty query keeps the providers' defaults in their order and
// moves up to five recent results above them.
func Rank(q Query, results []Result, usage Usage, now time.Time) []Result {
	pattern := strings.Join(q.Terms, " ")
	var out []Result
	for _, r := range results {
		u := usage.of(r.Key)
		switch {
		case q.Empty():
			if r.Recent && !isRecent(u, now) {
				continue
			}
			r.Score = r.Score*weightBase + boost(u, "", now)
		case pattern == "" || r.Always:
			r.Score = r.Score*weightBase + boost(u, q.Text, now)*weightUse
		default:
			m, ok := matchResult(&r, pattern)
			if !ok {
				continue
			}
			score := m*weightMatch + boost(u, q.Text, now)*weightUse
			if len(q.Paths) > 0 {
				score += r.Score * weightBase
			} else {
				score += coverage(r) + r.Score/10
			}
			r.Score = score
		}
		out = append(out, r)
	}
	if q.Empty() {
		out = liftRecents(out, usage, now)
		for i := range out {
			if out[i].Pinned {
				out[i].Score = 2 * recentBoost
			}
		}
	}
	out = dedupe(out)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > maxResults {
		out = out[:maxResults]
	}
	return grouped(q, out)
}

// grouped lists ranked results group by group, keeping the ranked order within each group. For
// the empty query, the groups follow groupOrder, then any other group, then results with no
// group. For a typed query, the groups are ordered by their best result, so the first row is
// still the best match.
func grouped(q Query, rs []Result) []Result {
	place := map[string]int{}
	if q.Empty() {
		for i, g := range groupOrder {
			place[g] = i
		}
	}
	for _, r := range rs {
		if _, ok := place[r.Group]; !ok && (r.Group != "" || !q.Empty()) {
			place[r.Group] = len(place)
		}
	}
	last := len(place) // where the empty query puts results with no group
	at := func(g string) int {
		if i, ok := place[g]; ok {
			return i
		}
		return last
	}
	sort.SliceStable(rs, func(i, j int) bool { return at(rs[i].Group) < at(rs[j].Group) })
	return rs
}

const (
	weightMatch = 100
	weightUse   = 50
	weightBase  = 10
)

// matchResult matches pattern against r's title (whose matched positions are drawn bold), its
// keywords, and their English (which is never drawn). A keyword match counts for less, and never
// as exact, so a result whose title also matches comes first.
func matchResult(r *Result, pattern string) (int, bool) {
	best, ok := match.Match(pattern, r.Title)
	score := best.Score
	if ok {
		r.match = best.Positions
	}
	for _, k := range slices.Concat(r.Keywords, r.English) {
		m, kok := match.Match(pattern, k)
		if !kok {
			continue
		}
		s := m.Score
		if match.Exact(pattern, k) {
			s -= match.ExactBonus
		}
		s = s * 3 / 4
		if !ok || s > score {
			score, ok = s, true
		}
	}
	return score, ok
}

// coverage returns how much of the title the match covers, from 0 to 100. For example, "c" covers
// more of "Copy" than of "Cleanup gdrive".
func coverage(r Result) int {
	n := len([]rune(r.Title))
	if n == 0 {
		return 0
	}
	return len(r.match) * 100 / n
}

// liftRecents puts the five most used recent results first.
func liftRecents(rs []Result, usage Usage, now time.Time) []Result {
	type pick struct {
		i     int
		score int
	}
	var picks []pick
	for i, r := range rs {
		if u := usage.of(r.Key); isRecent(u, now) {
			picks = append(picks, pick{i, boost(u, "", now)})
		}
	}
	sort.SliceStable(picks, func(a, b int) bool { return picks[a].score > picks[b].score })
	for n, p := range picks {
		if n >= recentMax {
			break
		}
		rs[p.i].Score = recentBoost + p.score
	}
	return rs
}

func dedupe(rs []Result) []Result {
	best := map[string]int{}
	var out []Result
	for _, r := range rs {
		if i, ok := best[r.ID]; ok {
			if r.Score > out[i].Score {
				out[i] = r
			}
			continue
		}
		best[r.ID] = len(out)
		out = append(out, r)
	}
	return out
}
