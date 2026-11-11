package update

import (
	"os"
	"testing"
)

// The switches that build/windows/nsis/project.nsi reads.
func TestNSISArgs(t *testing.T) {
	if got := nsisArgs(42, true); got != "/P /UPDATE /WAITPID=42 /R" {
		t.Errorf("nsisArgs(relaunch) = %q", got)
	}
	if got := nsisArgs(42, false); got != "/P /UPDATE /WAITPID=42" {
		t.Errorf("nsisArgs = %q", got)
	}
}

func TestSetEnvRestores(t *testing.T) {
	const key = "RCUI_TEST_SETENV"
	t.Setenv(key, "")
	_ = os.Unsetenv(key)
	restore, err := setEnv(key, "a")
	if err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv(key); got != "a" {
		t.Fatalf("set: %q", got)
	}
	restore()
	if v, ok := os.LookupEnv(key); ok {
		t.Fatalf("still set after restore: %q", v)
	}

	t.Setenv(key, "old")
	if restore, err = setEnv(key, "b"); err != nil {
		t.Fatal(err)
	}
	restore()
	if got := os.Getenv(key); got != "old" {
		t.Fatalf("restored to %q, want old", got)
	}
}
