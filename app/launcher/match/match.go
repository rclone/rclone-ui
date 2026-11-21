// Package match does the launcher's fuzzy matching. A pattern matches when its letters appear in
// order anywhere in a text. Matches are scored so that the ones a person most likely means come
// first (at the start of a word, as a run of letters, or at the start of the text). The matched
// positions are returned so they can be drawn bold.
package match

import (
	"strings"
	"unicode"
)

// Scores. A matched letter is worth scoreMatch, and its position can add a bonus. Every letter
// skipped between two matched ones costs a little, and the first skipped letter costs more.
const (
	scoreMatch       = 16
	gapStart         = -3
	gapExtension     = -1
	bonusBoundary    = 8  // at the start of a word: after a space, `-`, `_`, `/`, `:` or `.`
	bonusCamel       = 7  // an upper-case letter after a lower-case one
	bonusConsecutive = 4  // right after the previous matched letter
	bonusFirstChar   = 2  // multiplier for the bonus of the pattern's first letter
	bonusPrefix      = 20 // the match starts at the start of the text
	bonusWholeWord   = 12 // the pattern is a whole word of the text
)

// ExactBonus is added when the pattern matches the whole text.
const ExactBonus = 100

// Exact reports whether pattern equals text, ignoring case and surrounding spaces. Such a match
// earns ExactBonus.
func Exact(pattern, text string) bool {
	return strings.EqualFold(strings.TrimSpace(pattern), strings.TrimSpace(text))
}

// Result is a match: its score and the positions of the matched runes in the text, in order.
type Result struct {
	Score     int
	Positions []int
}

// Match finds each of pattern's words in text as letters in order, ignoring case. ok is false
// unless every word matches. An empty pattern matches with score 0.
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

// matchWord matches one word. It finds the first place where all its letters appear in order,
// then tightens the match backwards from the end to the shortest span ending there, and scores
// it.
func matchWord(p, text, lower []rune) (Result, bool) {
	if len(p) == 0 {
		return Result{}, true
	}
	// forward pass: find the earliest position where the last letter can match
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
	// A contiguous occurrence at the start of a word beats the first scattered one ("cp" is
	// scattered in "Copy" but a word in "cp files"), so look for the best contiguous one too.
	best, bestScore := []int(nil), -1<<30
	if pos, ok := contiguous(p, text, lower); ok {
		best, bestScore = pos, score(text, lower, pos, len(p))
	}
	// backward pass from end: find the latest start that still matches, for the shortest span
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

// contiguous finds p as a run of letters at its best position: the first one at the start of a
// word if there is one, and otherwise the first one.
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

// boundary returns the bonus that a match at i earns for its position: bonusBoundary at the start
// of a word, bonusCamel at a camelCase hump or at a digit after a letter, and 0 elsewhere.
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
