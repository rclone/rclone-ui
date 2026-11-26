package remotes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/rclone/rclone/backend/onedrive/api"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/fshttp"
	"golang.org/x/oauth2"
)

// oneDriveGraph is Microsoft Graph in OneDrive's global region, as rclone's onedrive backend
// calls it (graphAPIEndpoint). The other regions keep rclone's default drive.
const oneDriveGraph = "https://graph.microsoft.com/v1.0"

const meDriveWait = 10 * time.Second

// driveDefault returns the drive that OneDrive's drive question starts on, or "" for rclone's
// default. rclone starts on the first drive that /me/drives lists, which can be one that no longer
// opens. An edit or a reconnect starts on the remote's current drive, and a new remote on the
// drive that Graph names as the user's own (/me/drive).
func (ss *Sessions) driveDefault(x *session, q *fs.Option) string {
	if x.typ != "onedrive" || q.Name != "config_driveid" || x.answers["config_type"] != "onedrive" {
		return ""
	}
	section := ss.s.section(x.step.Remote)
	drives := make([]string, len(q.Examples))
	for i, choice := range q.Examples {
		drives[i] = choice.Value
	}
	current := ""
	if x.step.Kind != KindCreate {
		current = section["drive_id"]
	}
	me := ""
	if region := section["region"]; current == "" && (region == "" || region == "global") {
		ctx, cancel := context.WithTimeout(context.Background(), meDriveWait)
		defer cancel()
		var err error
		me, err = meDrive(ctx, fshttp.NewClient(ctx), oneDriveGraph, accessToken(section["token"]))
		if err != nil {
			ss.s.log.Debug("remotes: reading the user's own OneDrive drive", "error", err)
		}
	}
	return startDrive(drives, current, me)
}

func startDrive(drives []string, current, me string) string {
	for _, id := range []string{current, me} {
		if id != "" && slices.Contains(drives, id) {
			return id
		}
	}
	return ""
}

// accessToken returns the access token in a remote's token, or "" when it has none or it has
// expired.
func accessToken(token string) string {
	var t oauth2.Token
	if json.Unmarshal([]byte(token), &t) != nil || !t.Valid() {
		return ""
	}
	return t.AccessToken
}

// meDrive returns the id of the drive that Microsoft Graph names as the user's own.
func meDrive(ctx context.Context, client *http.Client, graphURL, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("no valid access token")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, graphURL+"/me/drive", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("/me/drive: %s", resp.Status)
	}
	var drive api.DriveResource
	if err := json.NewDecoder(resp.Body).Decode(&drive); err != nil {
		return "", fmt.Errorf("/me/drive: %w", err)
	}
	return drive.DriveID, nil
}
