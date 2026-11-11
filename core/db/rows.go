package db

import "database/sql"

// Scanner is a row to read: a *sql.Row, or the current row of a *sql.Rows. This lets one scan
// function serve both a single-row query and a multi-row query.
type Scanner interface {
	Scan(dest ...any) error
}

// Collect reads every row of rows with scan, then closes rows. It returns the values in order,
// as an empty slice (never nil) when there are no rows. On failure it returns the first error,
// either from a scan or from whatever ended the rows early.
func Collect[T any](rows *sql.Rows, scan func(Scanner) (T, error)) ([]T, error) {
	defer func() { _ = rows.Close() }()
	out := []T{}
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
