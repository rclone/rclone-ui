package children

import "testing"

func TestParseStat(t *testing.T) {
	// The command name may contain spaces and parentheses.
	const line = "4242 (rclone (x) y) S 1 4242 4242 0 -1 4194560 1234 0 0 0 10 5 0 0 20 0 12 0 987654 123456789 4000 18446744073709551615"
	got, err := parseStat(line)
	if err != nil || got != 987654 {
		t.Fatalf("parseStat = %d, %v; want 987654", got, err)
	}
	if _, err := parseStat("4242 (short) S 1"); err == nil {
		t.Fatal("a short line parsed")
	}
}
