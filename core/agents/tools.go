package agents

import (
	"context"
	"errors"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/transfers"
)

const instructions = `Rclone UI manages files on cloud storage with rclone. Each storage the user has connected is a "remote".

Paths: a remote path is "name:path/inside" ("gdrive:Photos/2024", or "gdrive:" for its root). A local path is absolute ("/Users/me/Documents", "C:\Users\me\Documents"). Call list_remotes first to learn the remotes' names.

Transfers (copy, move, sync, bisync, delete, purge, download) run in the background. Starting one returns its id at once: follow it with wait_for_transfer or get_transfer, and tell the user how it ended. The user sees every transfer in the app's History window.

Before anything that can delete or overwrite files (sync, move, delete, purge, bisync), run the same tool with dry_run set, read what it would do with get_transfer, and tell the user. Then run it for real only if that is what they asked for.

sync makes the destination identical to the source, deleting what is only in the destination. copy never deletes. Use copy unless the user asked for a mirror.

Options are rclone's own, by their rclone names with underscores ("max_age", "transfers"). Call list_options to see which an operation takes.`

func (s *Server) tools() {
	s.infoTools()
	s.fileTools()
	s.transferTools()
	s.runningTools()
	s.automationTools()
}

func reads(title string) *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{Title: title, ReadOnlyHint: true, OpenWorldHint: ptr(true)}
}

func changes(title string) *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{Title: title, DestructiveHint: ptr(false), OpenWorldHint: ptr(true)}
}

func destroys(title string) *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{Title: title, DestructiveHint: ptr(true), OpenWorldHint: ptr(true)}
}

func ptr[T any](v T) *T { return &v }

func add[In, Out any](s *Server, tool *mcp.Tool, handle func(ctx context.Context, in In) (Out, error)) {
	mcp.AddTool(s.mcp, tool, func(ctx context.Context, req *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
		client := clientName(req)
		ctx = context.WithValue(ctx, ctxKey{}, client)
		ctx = transfers.WithOrigin(ctx, transfers.Origin{Kind: transfers.OriginAgent, Name: client})
		began := time.Now()
		out, err := handle(ctx, in)
		if err != nil {
			message := rclone.ErrorOf(err).Message
			s.o.Log.Warn("an agent's tool call failed", "tool", tool.Name, "client", orUnnamed(client), "error", message)
			return nil, nil, errors.New(message)
		}
		s.o.Log.Info("an agent called a tool", "tool", tool.Name, "client", orUnnamed(client), "took", time.Since(began).Round(time.Millisecond).String())
		return nil, out, nil
	})
}

func orUnnamed(client string) string {
	if client == "" {
		return "unnamed"
	}
	return client
}
