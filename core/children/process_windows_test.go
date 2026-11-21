package children

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestChildrenAreInTheKillOnCloseJob(t *testing.T) {
	s := newSupervisor(t, Options{})
	up := make(chan struct{}, 1)
	spec := helperSpec("sleeper", "sleep")
	spec.OnUp = func(*Unit) { up <- struct{}{} }
	u, err := s.Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	waitClosed(t, up, 10*time.Second, "OnUp")
	// JOBOBJECT_BASIC_PROCESS_ID_LIST holds two counts, followed by the ids.
	var list struct {
		Assigned, InList uint32
		IDs              [64]uintptr
	}
	if err := windows.QueryInformationJobObject(s.os.job, windows.JobObjectBasicProcessIdList,
		uintptr(unsafe.Pointer(&list)), uint32(unsafe.Sizeof(list)), nil); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(list.IDs[:list.InList], uintptr(u.Process().PID())) {
		t.Fatalf("the child %d is not in the job %v", u.Process().PID(), list.IDs[:list.InList])
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := u.Stop(ctx); err != nil {
		t.Fatal(err)
	}
}

// TestChildrenAreNotOnTheAppsConsole checks that the children are not attached to the app's
// console. A Ctrl+C there reaches every attached process, so the children would end before the
// app's shutdown stops them.
func TestChildrenAreNotOnTheAppsConsole(t *testing.T) {
	if f := sysProcAttr().CreationFlags; f&windows.CREATE_NO_WINDOW == 0 || f&windows.CREATE_NEW_PROCESS_GROUP == 0 {
		t.Fatalf("creation flags %#x", f)
	}
	s := newSupervisor(t, Options{})
	up := make(chan struct{}, 1)
	spec := helperSpec("sleeper", "sleep")
	spec.OnUp = func(*Unit) { up <- struct{}{} }
	u, err := s.Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	waitClosed(t, up, 10*time.Second, "OnUp")
	buf := make([]uint32, 1024)
	n, _, err := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleProcessList").
		Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 {
		t.Skipf("the test has no console: %v", err)
	}
	attached := buf[:min(int(n), len(buf))]
	if !slices.Contains(attached, uint32(os.Getpid())) {
		t.Fatalf("the console's processes %v do not include the test", attached)
	}
	if slices.Contains(attached, uint32(u.Process().PID())) {
		t.Fatalf("the child %d is on the app's console", u.Process().PID())
	}
}
