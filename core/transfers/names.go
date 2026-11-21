package transfers

import (
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/operations"
)

// OperationName returns an operation's name as History shows it, in the app's language: "Sync"
// for sync, "Delete Folder" for delete-folder. The English names are the windows' titles. An
// operation without a name gives its key.
func OperationName(operation operations.Operation) string { return operationName(operation).Local() }

// operationName returns an operation's name as a translatable text, or the zero Text for an
// operation without a name.
func operationName(operation operations.Operation) i18n.Text {
	switch operation {
	case operations.OperationCopy:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Copy")
	case operations.OperationMove:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Move")
	case operations.OperationSync:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Sync")
	case operations.OperationBisync:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Bisync")
	case operations.OperationDelete:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Delete")
	case operations.OperationPurge:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Purge")
	case operations.OperationDownload:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Download")
	case operations.OperationMount:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Mount")
	case operations.OperationServe:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Serve")
	case operations.OperationCleanup:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Cleanup")
	case operations.OperationSave:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Save")
	case operations.OperationRename:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Rename")
	case operations.OperationDeleteFolder:
		// i18n: An operation's name, as History shows it.
		return i18n.M("Delete Folder")
	}
	return i18n.Text{}
}
