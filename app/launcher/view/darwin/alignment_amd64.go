//go:build darwin

package darwin

// NSTextAlignmentRight. AppKit gives it 1 on Intel and 2 on Apple silicon (NSText.h).
const textAlignmentRight = 1
