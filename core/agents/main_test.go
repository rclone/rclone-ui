// Tests for the agents' server. They run in this process on a real core, whose one remote, "box",
// is the local disk, and reach the tools the way an agent does: through an MCP client. When this
// binary is started as an rclone child (marked by childenv), it runs rclone's command line, as
// main.go does, so a test can mount or serve.
package agents

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	_ "github.com/rclone/rclone/backend/local"
	rclonecmd "github.com/rclone/rclone/cmd"
	_ "github.com/rclone/rclone/cmd/serve/http"
	rcloneconfig "github.com/rclone/rclone/fs/config"
	"github.com/spf13/cobra"
	"github.com/zalando/go-keyring"

	"github.com/rclone/rclone-ui/core"
	"github.com/rclone/rclone-ui/core/children/childenv"
	"github.com/rclone/rclone-ui/core/internal/testutil"
)

func TestMain(m *testing.M) {
	if _, ok := os.LookupEnv(childenv.Env); ok {
		childenv.Adopt(nil)
		rclonecmd.Root.PersistentPreRun = func(*cobra.Command, []string) { childenv.Ready() }
		rclonecmd.Root.SetArgs(os.Args[1:])
		rclonecmd.Main()
		os.Exit(0)
	}
	// A serve with a password keeps it in the keychain. The tests' home folder has no keychain,
	// and macOS would ask the person at the screen about it, so the tests get one in memory.
	keyring.MockInit()
	testutil.Main(m, func(dir string) error {
		home = dir
		conf := rcloneconfig.GetConfigPath()
		if err := os.MkdirAll(filepath.Dir(conf), 0o700); err != nil {
			return err
		}
		return os.WriteFile(conf, []byte("[box]\ntype = local\n"), 0o600)
	})
}

// The package's tests share one core, because rclone is set up once per process.
var (
	home    string // the tests' home folder
	once    sync.Once
	apis    *core.APIs
	dataDir string
	opened  []string // the routes that tools asked to open
	startup error
)

// server returns a server on the shared core. Its OpenWindow records the route in opened.
func server(t *testing.T) *Server {
	t.Helper()
	once.Do(func() {
		dataDir = filepath.Join(home, "data")
		runDir, err := os.MkdirTemp("", "rc") // a socket's path must stay short
		if err != nil {
			startup = err
			return
		}
		apis = core.NewAPIs(core.APIOptions{DataDir: dataDir})
		_, startup = core.Start(core.Options{DataDir: dataDir, RunDir: runDir, APIs: apis})
	})
	if startup != nil {
		t.Fatal(startup)
	}
	return New(Options{
		APIs: apis, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), DataDir: dataDir, Version: "test",
		OpenWindow: func(route string) error { opened = append(opened, route); return nil },
	})
}

// connect returns an agent's session with a server on the shared core, over a connection in
// memory. The agent calls itself "Test Agent".
func connect(t *testing.T) *mcp.ClientSession {
	t.Helper()
	return connectTo(t, server(t))
}

func connectTo(t *testing.T, s *Server) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	serverSide, clientSide := mcp.NewInMemoryTransports()
	ss, err := s.mcp.Connect(ctx, serverSide, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ss.Close() })
	return session(t, clientSide)
}

func session(t *testing.T, transport mcp.Transport) *mcp.ClientSession {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "test-agent", Title: "Test Agent", Version: "1"}, nil)
	cs, err := client.Connect(context.Background(), transport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

// call calls a tool and returns its output, decoded into Out, or the tool's error as text. It
// fails the test when the call itself fails, which is a protocol error rather than a tool's.
func call[Out any](t *testing.T, cs *mcp.ClientSession, tool string, args any) (Out, string) {
	t.Helper()
	var out Out
	if args == nil {
		args = map[string]any{}
	}
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", tool, err)
	}
	if res.IsError {
		text := ""
		for _, c := range res.Content {
			if tc, ok := c.(*mcp.TextContent); ok {
				text += tc.Text
			}
		}
		return out, text
	}
	b, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatalf("%s: %v", tool, err)
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("%s: its output %s doesn't decode: %v", tool, b, err)
	}
	return out, ""
}

// must is call for a tool that is expected to succeed.
func must[Out any](t *testing.T, cs *mcp.ClientSession, tool string, args any) Out {
	t.Helper()
	out, failed := call[Out](t, cs, tool, args)
	if failed != "" {
		t.Fatalf("%s failed: %s", tool, failed)
	}
	return out
}
