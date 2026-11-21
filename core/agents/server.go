// Package agents lets AI agents use the app, over the Model Context Protocol (MCP). An agent that
// is connected can do what the windows do: browse the remotes, start and follow transfers, mount,
// serve, and manage schedules and watchers. The tools call the core's APIs, the same ones that
// the pages call, so the same rules apply and everything shows in History.
//
// The server is off until the user turns it on in Settings (settings.Agents). It listens on this
// computer only, and a client must send the token. There are two ways in:
//
//   - HTTP, at http://127.0.0.1:<port>/mcp, for clients that take a URL and a header;
//   - `rcui mcp` (Bridge), which a client starts as a command and which passes its messages on to
//     the HTTP server. It finds the server through a file in the data folder (datadir.AgentsFile).
//
// The app doesn't ask the user before a tool runs. The agent's own client does that, and each
// tool says whether it only reads or may destroy something (its annotations). Tool descriptions
// and the errors that a tool returns are in English, because a model reads them.
package agents

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/rclone/rclone-ui/core"
	"github.com/rclone/rclone-ui/core/datadir"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/settings"
)

const Path = "/mcp"

type Options struct {
	APIs *core.APIs
	Log  *slog.Logger
	// DataDir is the app's data folder, where the server leaves the file that `rcui mcp` reads.
	DataDir string
	// Version is the app's version, which the server reports to its clients.
	Version string
	// OpenWindow opens the app's window for a route, such as "/history".
	OpenWindow func(route string) error
	// Changed is called with the new status each time the server starts, stops or fails to start.
	Changed func(Status)
}

type Status struct {
	Running bool `json:"running"`
	// URL is where the server answers while it runs.
	URL string `json:"url"`
	// Error says why the server couldn't start, in the app's language.
	Error string `json:"error"`
}

// Found is what `rcui mcp` reads from the data folder to reach the server: its address and its
// token.
type Found struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

// Server is the agents' server. Apply starts and stops it as the settings ask.
type Server struct {
	o   Options
	mcp *mcp.Server

	mu     sync.Mutex
	cfg    settings.Agents // what the running server was started with
	http   *http.Server
	status Status
	failed i18n.Text // why the last start failed, kept so that Status follows the language
}

// New returns the server, stopped. Its tools are registered once, here.
func New(o Options) *Server {
	s := &Server{o: o}
	s.mcp = mcp.NewServer(
		&mcp.Implementation{Name: "rclone-ui", Title: "Rclone UI", Version: o.Version},
		&mcp.ServerOptions{Instructions: instructions},
	)
	s.tools()
	return s
}

func (s *Server) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.status
	st.Error = s.failed.Local()
	return st
}

// Apply makes the server match the settings: started when they turn it on, stopped when they turn
// it off, and started again when its port or its token changed.
func (s *Server) Apply(cfg settings.Agents) {
	s.mu.Lock()
	if cfg == s.cfg && (s.status.Running || !cfg.Enabled) {
		s.mu.Unlock()
		return
	}
	s.stop()
	s.cfg = cfg
	if cfg.Enabled {
		s.failed = s.start(cfg)
		if !s.failed.IsZero() {
			s.o.Log.Error("the agents' server could not start", "port", cfg.Port, "error", s.failed.String())
		}
	}
	st := s.status
	st.Error = s.failed.Local()
	s.mu.Unlock()
	if s.o.Changed != nil {
		s.o.Changed(st)
	}
}

func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stop()
	s.cfg = settings.Agents{}
}

// start listens on the port and serves. It returns why it couldn't, or the zero Text. s.mu is held.
func (s *Server) start(cfg settings.Agents) i18n.Text {
	if cfg.Token == "" {
		// The settings make a token when the server is turned on, so this is a damaged document.
		return i18n.M("The agents' token is missing. Make a new one in Settings.")
	}
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		// i18n: %d is a port number. Another program on this computer already listens on it.
		return i18n.M("Port %d is in use by another program. Choose another port.", cfg.Port)
	}
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s.mcp }, nil)
	mux := http.NewServeMux()
	mux.Handle(Path, guard(cfg.Token, handler))
	s.http = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func(srv *http.Server) {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.o.Log.Error("the agents' server stopped", "error", err)
		}
	}(s.http)
	url := "http://" + addr + Path
	if err := writeFound(s.o.DataDir, Found{URL: url, Token: cfg.Token}); err != nil {
		// Clients that take the URL still work. Only `rcui mcp` can't find the server.
		s.o.Log.Error("could not write where the agents' server listens", "error", err)
	}
	s.status = Status{Running: true, URL: url}
	s.o.Log.Info("the agents' server listens", "url", url)
	return i18n.Text{}
}

// stop closes the server and its connections, and removes the file that names it. s.mu is held.
func (s *Server) stop() {
	if s.http == nil {
		s.status, s.failed = Status{}, i18n.Text{}
		return
	}
	// A session keeps a stream open for as long as its client stays, so the server is closed
	// rather than shut down gracefully.
	_ = s.http.Close()
	s.http = nil
	_ = os.Remove(filepath.Join(s.o.DataDir, datadir.AgentsFile))
	s.status, s.failed = Status{}, i18n.Text{}
	s.o.Log.Info("the agents' server stopped")
}

// guard lets a request through only when it is a local program's and carries the token.
//
// A web page can make this computer's browser send requests to 127.0.0.1. Such a request carries
// an Origin header, which no MCP client sends, so it is refused whatever else it holds. The SDK's
// handler also refuses a request whose Host isn't this computer (DNS rebinding).
func guard(token string, next http.Handler) http.Handler {
	want := []byte("Bearer " + token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" {
			http.Error(w, "requests from web pages are refused", http.StatusForbidden)
			return
		}
		got := []byte(strings.TrimSpace(r.Header.Get("Authorization")))
		if subtle.ConstantTimeCompare(got, want) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="Rclone UI"`)
			http.Error(w, "the token is missing or wrong: copy it from Rclone UI's Settings", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// writeFound writes where the server listens, in a file that only the user can read. It is
// written whole and then renamed, so `rcui mcp` never reads half of it.
func writeFound(dir string, f Found) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	path := filepath.Join(dir, datadir.AgentsFile)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// readFound reads what writeFound wrote. It fails when the server isn't running.
func readFound(dir string) (Found, error) {
	b, err := os.ReadFile(filepath.Join(dir, datadir.AgentsFile))
	if err != nil {
		return Found{}, err
	}
	var f Found
	if err := json.Unmarshal(b, &f); err != nil || f.URL == "" || f.Token == "" {
		return Found{}, fmt.Errorf("%s can't be read", datadir.AgentsFile)
	}
	return f, nil
}

// clientName returns the name that a tool call's client gave itself, such as "Claude Code", or ""
// when it gave none. For "", History shows its own word for an agent.
func clientName(req *mcp.CallToolRequest) string {
	if req != nil && req.Session != nil {
		if p := req.Session.InitializeParams(); p != nil && p.ClientInfo != nil {
			if p.ClientInfo.Title != "" {
				return p.ClientInfo.Title
			}
			if p.ClientInfo.Name != "" {
				return p.ClientInfo.Name
			}
		}
	}
	return ""
}

type ctxKey struct{}

// clientOf returns the name of the client whose tool call ctx belongs to.
func clientOf(ctx context.Context) string {
	name, _ := ctx.Value(ctxKey{}).(string)
	return name
}
