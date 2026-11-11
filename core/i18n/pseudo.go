package i18n

import "strings"

// accents maps the ASCII letters to accented ones that still read as the same letter.
var accents = strings.NewReplacer(
	"a", "á", "e", "é", "i", "í", "o", "ó", "u", "ú", "c", "ç", "n", "ñ", "y", "ý",
	"A", "Á", "E", "É", "I", "Í", "O", "Ó", "U", "Ú", "C", "Ç", "N", "Ñ", "Y", "Ý",
)

// pseudo returns format as the test language shows it: accented, and in brackets. fmt's verbs
// ("%s", "%[2]d", "%%") are kept as they are, so the message still formats.
func pseudo(format string) string {
	var b strings.Builder
	b.WriteByte('[')
	for format != "" {
		i := strings.IndexByte(format, '%')
		if i < 0 {
			b.WriteString(accents.Replace(format))
			break
		}
		b.WriteString(accents.Replace(format[:i]))
		end := i + 1
		// A verb runs from the "%" to its first letter, or is "%%".
		for end < len(format) && !isLetter(format[end]) && format[end] != '%' {
			end++
		}
		if end < len(format) {
			end++
		}
		b.WriteString(format[i:end])
		format = format[end:]
	}
	b.WriteByte(']')
	return b.String()
}

func isLetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }
