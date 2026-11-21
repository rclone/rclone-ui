package agents

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/rclone/rclone-ui/core/datadir"
	"github.com/rclone/rclone-ui/core/settings"
)

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestAboutAndRemotes(t *testing.T) {
	cs := connect(t)
	a := must[about](t, cs, "about", nil)
	if a.AppVersion == "" || a.RcloneVersion == "" || a.OS != runtime.GOOS {
		t.Errorf("about: %+v", a)
	}
	list := must[remoteList](t, cs, "list_remotes", nil)
	if len(list.Remotes) != 1 || list.Remotes[0].Name != "box" || list.Remotes[0].Type != "local" {
		t.Errorf("list_remotes: %+v", list)
	}
}

// Every tool says what it is and whether it only reads, so that an agent's client can ask its
// user before the ones that change something.
func TestToolsAreDescribed(t *testing.T) {
	cs := connect(t)
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Tools) == 0 {
		t.Fatal("no tools")
	}
	for _, tool := range res.Tools {
		if len(tool.Description) < 20 {
			t.Errorf("%s: its description is too short to tell an agent what it does", tool.Name)
		}
		a := tool.Annotations
		if a == nil || a.Title == "" {
			t.Errorf("%s: no title", tool.Name)
			continue
		}
		if !a.ReadOnlyHint && a.DestructiveHint == nil {
			t.Errorf("%s: a tool that changes something says whether it can destroy", tool.Name)
		}
	}
}

// The server runs only while the settings turn it on. It answers a client that has the token,
// and refuses one without it and any request from a web page.
func TestServerLifecycleAndGuard(t *testing.T) {
	s := server(t)
	var seen []Status
	s.o.Changed = func(st Status) { seen = append(seen, st) }
	cfg := settings.Agents{Enabled: true, Port: freePort(t), Token: "s3cret-token"}
	s.Apply(cfg)
	t.Cleanup(s.Close)
	st := s.Status()
	if !st.Running || st.Error != "" || !strings.HasSuffix(st.URL, Path) || len(seen) != 1 {
		t.Fatalf("status after a start: %+v, %d changes", st, len(seen))
	}
	found, err := readFound(dataDir)
	if err != nil || found.URL != st.URL || found.Token != cfg.Token {
		t.Fatalf("the file for the bridge: %+v %v", found, err)
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(filepath.Join(dataDir, datadir.AgentsFile)); err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("the file's mode: %v %v", info.Mode(), err)
		}
	}

	post := func(header, value string) int {
		req, _ := http.NewRequest(http.MethodPost, st.URL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if header != "" {
			req.Header.Set(header, value)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
		return res.StatusCode
	}
	if got := post("", ""); got != http.StatusUnauthorized {
		t.Errorf("without a token: %d", got)
	}
	if got := post("Authorization", "Bearer wrong"); got != http.StatusUnauthorized {
		t.Errorf("with a wrong token: %d", got)
	}

	// With the token, an agent connects over HTTP and uses a tool.
	client := &http.Client{Transport: withToken{cfg.Token}}
	cs := session(t, &mcp.StreamableClientTransport{Endpoint: st.URL, HTTPClient: client})
	if list := must[remoteList](t, cs, "list_remotes", nil); len(list.Remotes) != 1 {
		t.Errorf("over HTTP: %+v", list)
	}
	// A web page's request carries an Origin, and is refused even with the token.
	req, _ := http.NewRequest(http.MethodPost, st.URL, strings.NewReader(`{}`))
	req.Header.Set("Origin", "https://example.com")
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("from a web page: %d", res.StatusCode)
	}

	// A second server can't take the port, and says so.
	other := server(t)
	other.Apply(cfg)
	if st := other.Status(); st.Running || !strings.Contains(st.Error, "in use") {
		t.Errorf("a taken port: %+v", st)
	}

	// A new token starts the server again, and the old token stops working.
	cfg.Token = "another-token"
	s.Apply(cfg)
	if got := post("Authorization", "Bearer s3cret-token"); got != http.StatusUnauthorized {
		t.Errorf("the old token after a new one: %d", got)
	}

	cfg.Enabled = false
	s.Apply(cfg)
	if st := s.Status(); st.Running {
		t.Errorf("status after a stop: %+v", st)
	}
	if _, err := readFound(dataDir); err == nil {
		t.Error("the file for the bridge is still there after a stop")
	}
}

// `rcui mcp` passes an agent's messages to the server and back: the agent uses a tool through
// it, and the server sees the agent's own name.
func TestBridgeRelays(t *testing.T) {
	s := server(t)
	cfg := settings.Agents{Enabled: true, Port: freePort(t), Token: "bridge-token"}
	s.Apply(cfg)
	t.Cleanup(s.Close)
	found, err := find(context.Background(), dataDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The agent's side of the bridge's stdin and stdout.
	toBridge, agentOut := io.Pipe()
	agentIn, fromBridge := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- relay(context.Background(), found, &mcp.IOTransport{Reader: toBridge, Writer: fromBridge})
	}()
	cs := session(t, &mcp.IOTransport{Reader: agentIn, Writer: agentOut})
	if list := must[remoteList](t, cs, "list_remotes", nil); len(list.Remotes) != 1 || list.Remotes[0].Name != "box" {
		t.Errorf("through the bridge: %+v", list)
	}
	_ = cs.Close()
	_ = agentOut.Close()
	if err := <-done; err != nil {
		t.Errorf("the bridge ended with %v", err)
	}
}
