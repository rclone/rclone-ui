package match

import (
	"strings"
	"unicode"
)

const (
	scoreMatch       = 16
	gapStart         = -3
	gapExtension     = -1
	bonusBoundary    = 8
	bonusCamel       = 7
	bonusConsecutive = 4
	bonusFirstChar   = 2
	bonusPrefix      = 20
	bonusWholeWord   = 12
)

const ExactBonus = 100

func Exact(pattern, text string) bool {
	return strings.EqualFold(strings.TrimSpace(pattern), strings.TrimSpace(text))
}

type Result struct {
	Score     int
	Positions []int
}

func Match(pattern, text string) (Result, bool) {
	words := strings.Fields(pattern)
	if len(words) == 0 {
		return Result{}, true
	}
	t := []rune(text)
	lower := make([]rune, len(t))
	for i, r := range t {
		lower[i] = unicode.ToLower(r)
	}
	var total Result
	seen := map[int]bool{}
	for _, w := range words {
		r, ok := matchWord([]rune(strings.ToLower(w)), t, lower)
		if !ok {
			return Result{}, false
		}
		total.Score += r.Score
		for _, p := range r.Positions {
			if !seen[p] {
				seen[p] = true
				total.Positions = append(total.Positions, p)
			}
		}
	}
	if Exact(pattern, text) {
		total.Score += ExactBonus
	}
	sortInts(total.Positions)
	return total, true
}

func matchWord(p, text, lower []rune) (Result, bool) {
	if len(p) == 0 {
		return Result{}, true
	}
	pi, end := 0, -1
	for i, r := range lower {
		if r == p[pi] {
			pi++
			if pi == len(p) {
				end = i
				break
			}
		}
	}
	if end < 0 {
		return Result{}, false
	}
	best, bestScore := []int(nil), -1<<30
	if pos, ok := contiguous(p, text, lower); ok {
		best, bestScore = pos, score(text, lower, pos, len(p))
	}
	start := end
	pi = len(p) - 1
	for i := end; i >= 0; i-- {
		if lower[i] == p[pi] {
			pi--
			if pi < 0 {
				start = i
				break
			}
		}
	}
	pos := make([]int, 0, len(p))
	pi = 0
	for i := start; i <= end && pi < len(p); i++ {
		if lower[i] == p[pi] {
			pos = append(pos, i)
			pi++
		}
	}
	if s := score(text, lower, pos, len(p)); s > bestScore {
		best, bestScore = pos, s
	}
	return Result{Score: bestScore, Positions: best}, true
}

func contiguous(p, text, lower []rune) ([]int, bool) {
	first := -1
	for i := 0; i+len(p) <= len(lower); i++ {
		ok := true
		for k := range p {
			if lower[i+k] != p[k] {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		if first < 0 {
			first = i
		}
		if boundary(text, i) > 0 {
			first = i
			break
		}
	}
	if first < 0 {
		return nil, false
	}
	pos := make([]int, len(p))
	for k := range p {
		pos[k] = first + k
	}
	return pos, true
}

func score(text, lower []rune, pos []int, n int) int {
	s := 0
	for k, i := range pos {
		b := boundary(text, i)
		if k == 0 {
			b *= bonusFirstChar
		}
		s += scoreMatch + b
		if k > 0 {
			gap := i - pos[k-1] - 1
			if gap == 0 {
				s += bonusConsecutive
			} else {
				s += gapStart + gapExtension*(gap-1)
			}
		}
	}
	if len(pos) > 0 && pos[0] == 0 {
		s += bonusPrefix
	}
	if len(pos) == n && n > 0 {
		last := pos[len(pos)-1]
		contiguousRun := last-pos[0] == n-1
		endsWord := last+1 == len(lower) || !isWord(lower[last+1])
		if contiguousRun && boundary(text, pos[0]) > 0 && endsWord {
			s += bonusWholeWord
		}
	}
	return s
}

func boundary(text []rune, i int) int {
	if i == 0 {
		return bonusBoundary
	}
	prev, cur := text[i-1], text[i]
	switch {
	case !isWord(prev):
		return bonusBoundary
	case unicode.IsLower(prev) && unicode.IsUpper(cur):
		return bonusCamel
	case unicode.IsLetter(prev) && unicode.IsDigit(cur):
		return bonusCamel
	}
	return 0
}

func isWord(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

func sortInts(a []int) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}
