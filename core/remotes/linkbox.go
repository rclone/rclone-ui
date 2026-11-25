package remotes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"time"

	"github.com/rclone/rclone/fs"
	rcloneconfig "github.com/rclone/rclone/fs/config"

	"github.com/rclone/rclone-ui/core/httpx"
)

// Quota is extra information on a remote's card, so its request must not hold
// up the health check that decides whether the remote works.
const linkboxQuotaTimeout = 3 * time.Second

// A variable so tests can point the request at a local server.
var (
	linkboxInfoURL = "https://www.linkbox.to/api/user/info"
	linkboxClient  = httpx.New(linkboxQuotaTimeout)
)

type linkboxInfoResponse struct {
	Data struct {
		SizeCap  int64 `json:"size_cap"`
		SizeCurr int64 `json:"size_curr"`
	} `json:"data"`
}

func usageValue(value int64) *int64 { return &value }

// linkboxAbout returns the account quota of a linkbox remote. Its backend has
// no About feature, but the web API it uses for sign-in reports the capacity
// in user/info. The web_token is hidden in rclone's config screen, yet present
// in the saved section, and it is the credential that endpoint expects.
//
// Failures are silent: a missing quota must not make a working remote look
// faulty. The same applies to a token that rclone has not cached yet.
func linkboxAbout(ctx context.Context, name string) *fs.Usage {
	backend, ok := rcloneconfig.FileGetValue(name, "type")
	if !ok || backend != "linkbox" {
		return nil
	}
	token, ok := rcloneconfig.FileGetValue(name, "web_token")
	if !ok || token == "" {
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, linkboxQuotaTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		linkboxInfoURL+"?token="+url.QueryEscape(token), nil)
	if err != nil {
		return nil
	}
	response, err := linkboxClient.Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil
	}

	var info linkboxInfoResponse
	if err := json.NewDecoder(response.Body).Decode(&info); err != nil {
		return nil
	}
	total, used := info.Data.SizeCap, info.Data.SizeCurr
	if total <= 0 || used < 0 || used > total {
		return nil
	}
	return &fs.Usage{
		Total: usageValue(total),
		Used:  usageValue(used),
		Free:  usageValue(total - used),
	}
}
