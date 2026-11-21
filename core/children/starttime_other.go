//go:build !linux && !darwin && !windows

package children

import "errors"

func processStartTime(int) (int64, error) { return 0, errors.ErrUnsupported }
