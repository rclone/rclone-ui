package main

import (
	"os"

	"golang.org/x/sys/windows"
)

var attachConsole = windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole")

const attachParentProcess = ^uintptr(0)

// consoleForCLI gives a CLI role a console. rcui.exe is a GUI-subsystem executable, so Windows
// doesn't give it one. When it runs from a terminal, it attaches to the terminal's console. A
// process started with its handles already set, such as a child with pipes or a redirect, keeps
// them.
func consoleForCLI() {
	if h, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE); err == nil && h != 0 && h != windows.InvalidHandle {
		return
	}
	if r, _, _ := attachConsole.Call(attachParentProcess); r == 0 {
		return
	}
	if f, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout, os.Stderr = f, f
	}
	if f, err := os.OpenFile("CONIN$", os.O_RDONLY, 0); err == nil {
		os.Stdin = f
	}
}
