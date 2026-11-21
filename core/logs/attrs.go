package logs

import (
	"context"
	"strings"
)

// Attr links the lines logged with a context to a transfer, a job or an operation, which are
// columns of the record. Add them to a context with With.
type Attr struct {
	col column
	str string
	num int64
}

type column int

const (
	colStatsGroup column = iota
	colTransfer
	colJob
	colOperation
)

func Transfer(id string) Attr { return Attr{col: colTransfer, str: id} }

// Operation is the transfer's operation (copy, sync and so on).
func Operation(op string) Attr { return Attr{col: colOperation, str: op} }

// StatsGroup is rclone's stats group. A group named `transfer/<id>` also sets the transfer.
func StatsGroup(g string) Attr { return Attr{col: colStatsGroup, str: g} }

// Job is rclone's job id.
func Job(id int64) Attr { return Attr{col: colJob, num: id} }

// attribution is what a context says its lines belong to.
type attribution struct {
	statsGroup, transfer, operation string
	job                             int64
}

type attributionKey struct{}

// With returns ctx with attrs added to the attribution it already carries. A later value for
// the same column replaces the earlier one.
func With(ctx context.Context, attrs ...Attr) context.Context {
	var a attribution
	if parent, ok := ctx.Value(attributionKey{}).(*attribution); ok {
		a = *parent
	}
	for _, at := range attrs {
		switch at.col {
		case colStatsGroup:
			a.statsGroup = at.str
		case colTransfer:
			a.transfer = at.str
		case colJob:
			a.job = at.num
		case colOperation:
			a.operation = at.str
		}
	}
	return context.WithValue(ctx, attributionKey{}, &a)
}

// attribute fills the attribution columns that r hasn't set.
func (a *attribution) attribute(r *Record) {
	set := func(dst *string, v string) {
		if *dst == "" {
			*dst = v
		}
	}
	set(&r.StatsGroup, a.statsGroup)
	set(&r.Transfer, a.transfer)
	set(&r.Operation, a.operation)
	if r.Job == 0 {
		r.Job = a.job
	}
}

// transferOfGroup returns the transfer ID in stats group g, or "" when g isn't a transfer's
// group.
func transferOfGroup(g string) string {
	if id, ok := strings.CutPrefix(g, "transfer/"); ok {
		return id
	}
	return ""
}
