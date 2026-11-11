package deeplink

import "strings"

// execEscapes escapes a quoted argument of the Exec key in a .desktop file, following the Desktop
// Entry specification. Inside the quotes, a double quote, a backtick, `$` and `\` each get a
// backslash. Then the general string escaping, which is applied first when reading, doubles every
// backslash. `%` is doubled too, or it would be read as a field code. So a literal backslash
// becomes four backslashes, and a `$` becomes `\\$`.
var execEscapes = strings.NewReplacer(`\`, `\\\\`, `"`, `\\"`, "`", "\\\\`", `$`, `\\$`, `%`, `%%`)

// QuoteExec quotes a path as one argument of the Exec key in a .desktop file (Linux). A field code
// such as %u goes after it, outside the quotes.
func QuoteExec(path string) string {
	return `"` + execEscapes.Replace(path) + `"`
}
