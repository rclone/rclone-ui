//go:build !darwin

package app

func osEndingSession() bool { return false }
