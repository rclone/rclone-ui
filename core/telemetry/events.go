package telemetry

import (
	"fmt"
	"math"
)

// kind is what a property of a page's event may hold. None can hold free text, so a page can't
// send a path or a name even by mistake.
type kind int

const (
	flag  kind = iota // true or false
	count             // a whole number, zero or more
)

// pageEvents are the events that a page may send (Track), each with its properties. An event or
// a property that isn't listed here is refused. To record something new from a page, add it here.
var pageEvents = map[string]map[string]kind{
	// The Commander's tools.
	"disk_usage_opened":   {"local": flag},
	"compare_opened":      {},
	"batch_rename_opened": {"items": count},
}

// Track sends a page's event, when it is one of pageEvents and its properties are of the kinds
// listed there. Anything else is refused, so that a mistake in a page shows while it is written
// rather than send something it shouldn't. The refusal is for the page's developer, so it stays
// in English.
func (s *Service) Track(name string, props map[string]any) error {
	allowed, ok := pageEvents[name]
	if !ok {
		return fmt.Errorf("%s is not an event that a page can send", name)
	}
	out := make(map[string]any, len(props))
	for key, value := range props {
		want, ok := allowed[key]
		if !ok {
			return fmt.Errorf("%s has no property %s", name, key)
		}
		switch v := value.(type) {
		case bool:
			if want != flag {
				return fmt.Errorf("%s of %s is a number", key, name)
			}
			out[key] = v
		case float64: // a number, as it arrives from a page
			if want != count || v < 0 || v != math.Trunc(v) {
				return fmt.Errorf("%s of %s is not a count", key, name)
			}
			out[key] = int64(v)
		default:
			return fmt.Errorf("%s of %s can't be sent", key, name)
		}
	}
	s.Capture(name, out)
	return nil
}
