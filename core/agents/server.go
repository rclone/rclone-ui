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
	APIs       *core.APIs
	Log        *slog.Logger
	DataDir    string
	Version    string
	OpenWindow func(route string) error
	// Changed is called with the new status each time the server starts, stops or fails to start.
	Changed func(Status)
}

type Status struct {
	Running bool   `json:"running"`
	URL     string `json:"url"`
	// Error says why the server couldn't start, in the app's language.
	Error string `json:"error"`
}

type Found struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

type Server struct {
	o   Options
	mcp *mcp.Server

	mu     sync.Mutex
	cfg    settings.Agents
	http   *http.Server
	status Status
	failed i18n.Text
}

// New returns the server, stopped.
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

func (s *Server) start(cfg settings.Agents) i18n.Text {
	if cfg.Token == "" {
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
		s.o.Log.Error("could not write where the agents' server listens", "error", err)
	}
	s.status = Status{Running: true, URL: url}
	s.o.Log.Info("the agents' server listens", "url", url)
	return i18n.Text{}
}

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

func clientOf(ctx context.Context) string {
	name, _ := ctx.Value(ctxKey{}).(string)
	return name
}
