package children

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// sysProcAttr keeps every child off the app's console. A Ctrl+C (or Ctrl+Break) in a console
// reaches every process attached to it, and rclone (lib/atexit) exits when it gets one. The
// children would then end before the app's shutdown stops them, they would look like crashes,
// and their upload queues would never be read. So each child gets its own hidden console, which
// the processes it starts share, so no window opens, and its own process group. Nothing needs
// the shared console, because a stop uses TerminateProcess.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW | windows.CREATE_NEW_PROCESS_GROUP}
}

// osState holds the supervisor's Job Object. Every child is assigned to it, and Windows kills
// them all when the app's handle to it closes, however the app ends. The handle is not
// inheritable, so no child holds it.
type osState struct {
	once sync.Once
	job  windows.Handle
	err  error
}

// afterStart assigns the child to the job. os/exec can't start a process suspended, so if the
// app is killed before this runs, the child is orphaned. children.json covers that case.
func (o *osState) afterStart(pid int) error {
	o.once.Do(func() { o.job, o.err = newKillOnCloseJob() })
	if o.err != nil {
		return o.err
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("open the child for its job: %w", err)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	if err := windows.AssignProcessToJobObject(o.job, h); err != nil {
		return fmt.Errorf("assign the child to the job: %w", err)
	}
	return nil
}

func newKillOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("create the children's job: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return 0, fmt.Errorf("set the children's job to kill on close: %w", err)
	}
	return job, nil
}

// terminate kills the child, because Go can't send os.Interrupt to a child on Windows. WinFsp
// removes a mount's drive when its process ends, so no unmount is needed.
func terminate(p *os.Process) error { return kill(p) }

func kill(p *os.Process) error {
	if err := p.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}

func killGroup(int) {}

func killLeftover(pid int) error {
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	return windows.TerminateProcess(h, 1)
}
