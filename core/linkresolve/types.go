package linkresolve

// Kind is the type of media at a resolved address.
type Kind string

const (
	KindVideo Kind = "video"
	KindAudio Kind = "audio"
	KindImage Kind = "image"
	KindFile  Kind = "file"
)

// Link is the media behind a page address: the address rclone downloads, the file name it is
// saved as, and the kind of media.
type Link struct {
	URL      string `json:"url"`
	Filename string `json:"filename"`
	Type     Kind   `json:"type"`
}

// Site is one website whose page addresses are resolved. A host in Hosts matches itself and its
// subdomains.
type Site struct {
	Name  string   `json:"name"`
	Hosts []string `json:"hosts"`
}
