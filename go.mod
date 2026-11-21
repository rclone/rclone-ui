module github.com/rclone/rclone-ui

go 1.26.0

toolchain go1.26.7

godebug x509negativeserial=1

require (
	github.com/FilenCloudDienste/filen-sdk-go v0.0.39
	github.com/cloudflare/cloudflared v0.0.0-20260924153110-96d39adbc812
	github.com/coreos/go-semver v0.3.1
	github.com/ebitengine/purego v0.11.1
	github.com/godbus/dbus/v5 v5.2.2
	github.com/google/uuid v1.6.0
	github.com/klauspost/compress v1.19.0
	github.com/leonelquinteros/gotext v1.7.2
	github.com/modelcontextprotocol/go-sdk v1.8.0
	github.com/ncruces/zenity v0.10.14
	github.com/posthog/posthog-go v1.42.2
	github.com/rclone/gofakes3 v0.0.9
	github.com/rclone/rclone v1.75.1
	github.com/robfig/cron/v3 v3.0.1
	github.com/spf13/cobra v1.10.2
	github.com/spf13/pflag v1.0.10
	github.com/unknwon/goconfig v1.0.0
	github.com/urfave/cli/v2 v2.24.4
	github.com/wailsapp/wails/v3 v3.1.0
	github.com/wneessen/go-mail v0.8.1
	github.com/zalando/go-keyring v0.2.8
	golang.org/x/crypto v0.57.0
	golang.org/x/sys v0.48.0
	golang.org/x/term v0.46.0
	golang.org/x/text v0.42.0
	modernc.org/sqlite v1.60.0
	rsc.io/qr v0.2.0
)

require (
	bazil.org/fuse v0.0.0-20230120002735-62a210ff1fd5 // indirect
	cloud.google.com/go/auth v0.20.0 // indirect
	cloud.google.com/go/auth/oauth2adapt v0.2.8 // indirect
	cloud.google.com/go/compute/metadata v0.9.0 // indirect
	git.sr.ht/~jackmordaunt/go-toast/v2 v2.0.3 // indirect
	github.com/Azure/azure-sdk-for-go/sdk/azcore v1.22.0 // indirect
	github.com/Azure/azure-sdk-for-go/sdk/azidentity v1.14.0 // indirect
	github.com/Azure/azure-sdk-for-go/sdk/internal v1.12.0 // indirect
	github.com/Azure/azure-sdk-for-go/sdk/storage/azblob v1.8.0 // indirect
	github.com/Azure/azure-sdk-for-go/sdk/storage/azfile v1.7.0 // indirect
	github.com/Azure/go-ntlmssp v0.1.1 // indirect
	github.com/AzureAD/microsoft-authentication-library-for-go v1.7.2 // indirect
	github.com/BurntSushi/toml v1.6.0 // indirect
	github.com/Files-com/files-sdk-go/v3 v3.3.194 // indirect
	github.com/IBM/go-sdk-core/v5 v5.23.1 // indirect
	github.com/Max-Sum/base32768 v0.0.0-20230304063302-18e6ce5945fd // indirect
	github.com/Microsoft/go-winio v0.6.2 // indirect
	github.com/ProtonMail/bcrypt v0.0.0-20211005172633-e235017c1baf // indirect
	github.com/ProtonMail/gluon v0.17.1-0.20230724134000-308be39be96e // indirect
	github.com/ProtonMail/go-crypto v1.4.1 // indirect
	github.com/ProtonMail/go-srp v0.0.7 // indirect
	github.com/ProtonMail/gopenpgp/v3 v3.4.1 // indirect
	github.com/PuerkitoBio/goquery v1.12.0 // indirect
	github.com/STARRY-S/zip v0.2.3 // indirect
	github.com/a1ex3/zstd-seekable-format-go/pkg v0.10.0 // indirect
	github.com/a8m/tree v0.0.0-20240104212747-2c8764a5f17e // indirect
	github.com/aalpar/deheap v1.1.2 // indirect
	github.com/abbot/go-http-auth v0.4.0 // indirect
	github.com/adrg/xdg v0.5.3 // indirect
	github.com/akavel/rsrc v0.10.2 // indirect
	github.com/anacrolix/dms v1.7.2 // indirect
	github.com/anacrolix/generics v0.2.0 // indirect
	github.com/anacrolix/log v0.17.0 // indirect
	github.com/anchore/go-lzo v0.1.1 // indirect
	github.com/andybalholm/brotli v1.2.2 // indirect
	github.com/andybalholm/cascadia v1.3.4 // indirect
	github.com/apache/arrow-go/v18 v18.7.0 // indirect
	github.com/appscode/go-querystring v0.0.0-20170504095604-0126cfb3f1dc // indirect
	github.com/atotto/clipboard v0.1.4 // indirect
	github.com/aws/aws-sdk-go-v2 v1.43.7 // indirect
	github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream v1.7.18 // indirect
	github.com/aws/aws-sdk-go-v2/config v1.32.30 // indirect
	github.com/aws/aws-sdk-go-v2/credentials v1.19.29 // indirect
	github.com/aws/aws-sdk-go-v2/feature/ec2/imds v1.18.30 // indirect
	github.com/aws/aws-sdk-go-v2/feature/s3/manager v1.22.34 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.4.38 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.7.38 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.4.39 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.13.17 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/checksum v1.9.31 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.13.38 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/s3shared v1.19.39 // indirect
	github.com/aws/aws-sdk-go-v2/service/s3 v1.107.3 // indirect
	github.com/aws/aws-sdk-go-v2/service/signin v1.4.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/sso v1.32.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/ssooidc v1.37.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/sts v1.44.1 // indirect
	github.com/aws/smithy-go v1.27.8 // indirect
	github.com/bahlo/generic-list-go v0.2.0 // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/bodgit/plumbing v1.3.0 // indirect
	github.com/bodgit/sevenzip v1.6.5 // indirect
	github.com/bodgit/windows v1.0.1 // indirect
	github.com/boombuler/barcode v1.1.0 // indirect
	github.com/bradenaw/juniper v0.15.3 // indirect
	github.com/buengese/sgzip v0.1.1 // indirect
	github.com/buger/jsonparser v1.2.0 // indirect
	github.com/calebcase/tmpfile v1.0.3 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/chilts/sid v0.0.0-20190607042430-660e94789ec9 // indirect
	github.com/clipperhouse/uax29/v2 v2.7.0 // indirect
	github.com/cloudflare/backoff v0.0.0-20240920015135-e46b80a3a7d0 // indirect
	github.com/cloudflare/circl v1.6.4 // indirect
	github.com/cloudinary/cloudinary-go/v2 v2.16.0 // indirect
	github.com/cloudsoda/go-smb2 v0.0.0-20260701064823-d8c5600d73b8 // indirect
	github.com/cloudsoda/sddl v0.0.0-20250224235906-926454e91efc // indirect
	github.com/coder/websocket v1.8.14 // indirect
	github.com/colinmarc/hdfs/v2 v2.4.0 // indirect
	github.com/coreos/go-oidc/v3 v3.17.0 // indirect
	github.com/coreos/go-systemd/v22 v22.6.0 // indirect
	github.com/cpuguy83/go-md2man/v2 v2.0.7 // indirect
	github.com/creasty/defaults v1.8.0 // indirect
	github.com/cronokirby/saferith v0.33.1-0.20250226174546-1f11f94ce488 // indirect
	github.com/danieljoos/wincred v1.2.3 // indirect
	github.com/davecgh/go-spew v1.1.2-0.20180830191138-d8f796af33cc // indirect
	github.com/dchest/jsmin v0.0.0-20220218165748-59f39799265f // indirect
	github.com/diskfs/go-diskfs v1.9.4 // indirect
	github.com/dromara/dongle v1.0.1 // indirect
	github.com/dropbox/dropbox-sdk-go-unofficial/v6 v6.4.0 // indirect
	github.com/dsnet/compress v0.0.2-0.20230904184137-39efe44ab707 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/emersion/go-message v0.18.2 // indirect
	github.com/emersion/go-vcard v0.0.0-20260618161152-d854b7e0e2d3 // indirect
	github.com/facebookgo/grace v0.0.0-20180706040059-75cf19382434 // indirect
	github.com/felixge/httpsnoop v1.1.0 // indirect
	github.com/flynn/noise v1.1.0 // indirect
	github.com/fsnotify/fsnotify v1.9.0 // indirect
	github.com/gabriel-vasile/mimetype v1.4.13 // indirect
	github.com/gdamore/encoding v1.0.1 // indirect
	github.com/gdamore/tcell/v2 v2.9.0 // indirect
	github.com/geoffgarside/ber v1.2.0 // indirect
	github.com/getsentry/sentry-go v0.49.0 // indirect
	github.com/go-chi/chi/v5 v5.3.1 // indirect
	github.com/go-chi/cors v1.2.1 // indirect
	github.com/go-darwin/apfs v0.0.0-20211011131704-f84b94dbf348 // indirect
	github.com/go-git/go-billy/v5 v5.9.0 // indirect
	github.com/go-jose/go-jose/v4 v4.1.4 // indirect
	github.com/go-logr/logr v1.4.4 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/go-openapi/errors v0.22.8 // indirect
	github.com/go-openapi/strfmt v0.27.0 // indirect
	github.com/go-playground/locales v0.14.1 // indirect
	github.com/go-playground/universal-translator v0.18.1 // indirect
	github.com/go-playground/validator/v10 v10.30.3 // indirect
	github.com/go-resty/resty/v2 v2.17.2 // indirect
	github.com/go-viper/mapstructure/v2 v2.5.0 // indirect
	github.com/gobwas/httphead v0.1.0 // indirect
	github.com/gobwas/pool v0.2.1 // indirect
	github.com/gobwas/ws v1.2.1 // indirect
	github.com/goccy/go-json v0.10.6 // indirect
	github.com/gofrs/flock v0.13.0 // indirect
	github.com/gogo/protobuf v1.3.2 // indirect
	github.com/golang-jwt/jwt/v4 v4.5.2 // indirect
	github.com/golang-jwt/jwt/v5 v5.3.1 // indirect
	github.com/google/btree v1.1.3 // indirect
	github.com/google/flatbuffers v25.12.19+incompatible // indirect
	github.com/google/gopacket v1.1.19 // indirect
	github.com/google/jsonschema-go v0.4.3 // indirect
	github.com/google/s2a-go v0.1.9 // indirect
	github.com/googleapis/enterprise-certificate-proxy v0.3.18 // indirect
	github.com/googleapis/gax-go/v2 v2.22.0 // indirect
	github.com/gopherjs/gopherjs v1.21.0 // indirect
	github.com/gorilla/schema v1.4.1 // indirect
	github.com/gorilla/websocket v1.5.3 // indirect
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.29.0 // indirect
	github.com/hanwen/go-fuse/v2 v2.10.1 // indirect
	github.com/hashicorp/errwrap v1.0.0 // indirect
	github.com/hashicorp/go-cleanhttp v0.5.2 // indirect
	github.com/hashicorp/go-multierror v1.1.1 // indirect
	github.com/hashicorp/go-retryablehttp v0.7.8 // indirect
	github.com/hashicorp/go-uuid v1.0.3 // indirect
	github.com/hashicorp/golang-lru/v2 v2.0.7 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/internxt/rclone-adapter v0.0.0-20260708165336-dd6561bacfa2 // indirect
	github.com/jcmturner/aescts/v2 v2.0.0 // indirect
	github.com/jcmturner/dnsutils/v2 v2.0.0 // indirect
	github.com/jcmturner/gofork v1.7.6 // indirect
	github.com/jcmturner/goidentity/v6 v6.0.1 // indirect
	github.com/jcmturner/gokrb5/v8 v8.4.4 // indirect
	github.com/jcmturner/rpc/v2 v2.0.3 // indirect
	github.com/jlaffaye/ftp v0.2.1-0.20251026020404-6602e981a1bb // indirect
	github.com/josephspurrier/goversioninfo v1.7.0 // indirect
	github.com/json-iterator/go v1.1.12 // indirect
	github.com/jtolds/gls v4.20.0+incompatible // indirect
	github.com/jtolio/noiseconn v0.0.0-20231127013910-f6d9ecbf1de7 // indirect
	github.com/jzelinskie/whirlpool v0.0.0-20201016144138-0675e54bb004 // indirect
	github.com/klauspost/cpuid/v2 v2.4.0 // indirect
	github.com/klauspost/pgzip v1.2.6 // indirect
	github.com/koofr/go-httpclient v0.0.0-20240520111329-e20f8f203988 // indirect
	github.com/koofr/go-koofrclient v0.0.0-20221207135200-cbd7fc9ad6a6 // indirect
	github.com/kr/fs v0.1.0 // indirect
	github.com/kylelemons/godebug v1.1.0 // indirect
	github.com/lanrat/extsort v1.4.2 // indirect
	github.com/leodido/go-urn v1.4.0 // indirect
	github.com/lpar/calendar v0.2.0 // indirect
	github.com/lucasb-eyer/go-colorful v1.4.0 // indirect
	github.com/lufia/plan9stats v0.0.0-20260627054121-477a66015f15 // indirect
	github.com/mailru/easyjson v0.9.2 // indirect
	github.com/mattn/go-colorable v0.1.15 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/mattn/go-runewidth v0.0.24 // indirect
	github.com/mholt/archives v0.1.5 // indirect
	github.com/mikelolasagasti/xz v1.0.1 // indirect
	github.com/minio/minlz v1.2.0 // indirect
	github.com/minio/xxml v0.0.3 // indirect
	github.com/mitchellh/go-homedir v1.1.0 // indirect
	github.com/moby/sys/mountinfo v0.7.2 // indirect
	github.com/modern-go/concurrent v0.0.0-20180306012644-bacd9c7ef1dd // indirect
	github.com/modern-go/reflect2 v1.0.2 // indirect
	github.com/muesli/reflow v0.3.0 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/ncw/swift/v2 v2.0.5 // indirect
	github.com/nwaples/rardecode/v2 v2.2.5 // indirect
	github.com/oklog/ulid/v2 v2.1.1 // indirect
	github.com/oracle/oci-go-sdk/v65 v65.121.0 // indirect
	github.com/panjf2000/ants/v2 v2.12.1 // indirect
	github.com/patrickmn/go-cache v2.1.0+incompatible // indirect
	github.com/pengsrc/go-shared v0.2.1-0.20190131101655-1999055a4a14 // indirect
	github.com/peterh/liner v1.2.2 // indirect
	github.com/pierrec/lz4/v4 v4.1.27 // indirect
	github.com/pkg/browser v0.0.0-20240102092130-5ac0b6a4141c // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/pkg/sftp v1.13.11 // indirect
	github.com/pkg/xattr v0.4.12 // indirect
	github.com/pmezard/go-difflib v1.0.1-0.20181226105442-5d4384ee4fb2 // indirect
	github.com/power-devops/perfstat v0.0.0-20240221224432-82ca36839d55 // indirect
	github.com/pquerna/otp v1.5.0 // indirect
	github.com/prometheus/client_golang v1.23.2 // indirect
	github.com/prometheus/client_model v0.6.2 // indirect
	github.com/prometheus/common v0.70.0 // indirect
	github.com/prometheus/procfs v0.21.1 // indirect
	github.com/putdotio/go-putio/putio v0.0.0-20200123120452-16d982cac2b8 // indirect
	github.com/quic-go/quic-go v0.59.1 // indirect
	github.com/randall77/makefat v0.0.0-20210315173500-7ddd0e42c844 // indirect
	github.com/rasky/go-xdr v0.0.0-20170124162913-1a41d1a06c93 // indirect
	github.com/rclone/Proton-API-Bridge v1.0.5 // indirect
	github.com/rclone/go-proton-api v1.0.4 // indirect
	github.com/relvacode/iso8601 v1.7.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/rfjakob/eme v1.2.0 // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	github.com/rs/zerolog v1.20.0 // indirect
	github.com/russross/blackfriday/v2 v2.1.0 // indirect
	github.com/ryszard/goskiplist v0.0.0-20150312221310-2dfbae5fcf46 // indirect
	github.com/sabhiram/go-gitignore v0.0.0-20210923224102-525f6e181f06 // indirect
	github.com/samber/lo v1.53.0 // indirect
	github.com/segmentio/asm v1.1.3 // indirect
	github.com/segmentio/encoding v0.5.4 // indirect
	github.com/shabbyrobe/gocovmerge v0.0.0-20230507112040-c3350d9342df // indirect
	github.com/shirou/gopsutil/v4 v4.26.6 // indirect
	github.com/sirupsen/logrus v1.9.4 // indirect
	github.com/skratchdot/open-golang v0.0.0-20200116055534-eef842397966 // indirect
	github.com/smarty/assertions v1.16.0 // indirect
	github.com/sony/gobreaker/v2 v2.4.0 // indirect
	github.com/sorairolake/lzip-go v0.3.8 // indirect
	github.com/spacemonkeygo/monkit/v3 v3.0.25-0.20251022131615-eb24eb109368 // indirect
	github.com/spf13/afero v1.15.0 // indirect
	github.com/stangelandcl/ppmd v0.1.1 // indirect
	github.com/stretchr/testify v1.11.1 // indirect
	github.com/t3rm1n4l/go-mega v0.0.0-20260717075258-c6acd6a5bd04 // indirect
	github.com/tklauser/go-sysconf v0.4.0 // indirect
	github.com/tklauser/numcpus v0.12.0 // indirect
	github.com/tyler-smith/go-bip39 v1.1.0 // indirect
	github.com/ulikunitz/xz v0.5.15 // indirect
	github.com/willscott/go-nfs v0.0.4 // indirect
	github.com/willscott/go-nfs-client v0.0.0-20251022144359-801f10d98886 // indirect
	github.com/winfsp/cgofuse v1.6.1-0.20260126094232-f2c4fccdb286 // indirect
	github.com/wk8/go-ordered-map/v2 v2.1.8 // indirect
	github.com/xanzy/ssh-agent v0.3.3 // indirect
	github.com/yosida95/uritemplate/v3 v3.0.2 // indirect
	github.com/youmark/pkcs8 v0.0.0-20240726163527-a2c0da244d78 // indirect
	github.com/yunify/qingstor-sdk-go/v3 v3.2.0 // indirect
	github.com/yusufpapurcu/wmi v1.2.4 // indirect
	github.com/zeebo/blake3 v0.2.4 // indirect
	github.com/zeebo/errs v1.4.0 // indirect
	github.com/zeebo/xxh3 v1.1.0 // indirect
	go.etcd.io/bbolt v1.5.0 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.69.0 // indirect
	go.opentelemetry.io/contrib/propagators v0.22.0 // indirect
	go.opentelemetry.io/otel v1.45.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace v1.45.0 // indirect
	go.opentelemetry.io/otel/metric v1.45.0 // indirect
	go.opentelemetry.io/otel/sdk v1.45.0 // indirect
	go.opentelemetry.io/otel/trace v1.45.0 // indirect
	go.opentelemetry.io/proto/otlp v1.11.0 // indirect
	go.yaml.in/yaml/v2 v2.4.4 // indirect
	go.yaml.in/yaml/v3 v3.0.4 // indirect
	go4.org v0.0.0-20260112195520-a5071408f32f // indirect
	goftp.io/server/v2 v2.0.3 // indirect
	golang.org/x/exp v0.0.0-20260709172345-9ea1abe57597 // indirect
	golang.org/x/image v0.45.0 // indirect
	golang.org/x/net v0.60.0 // indirect
	golang.org/x/oauth2 v0.36.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/time v0.15.0 // indirect
	golang.org/x/tools v0.50.0 // indirect
	google.golang.org/api v0.279.0 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20260720211330-0afa2a65878a // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260720211330-0afa2a65878a // indirect
	google.golang.org/grpc v1.84.0-dev.0.20260723093437-b6eac429d7b6 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
	gopkg.in/natefinch/lumberjack.v2 v2.2.1 // indirect
	gopkg.in/validator.v2 v2.0.1 // indirect
	gopkg.in/yaml.v2 v2.4.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	modernc.org/libc v1.77.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
	moul.io/http2curl/v2 v2.3.0 // indirect
	nhooyr.io/websocket v1.8.7 // indirect
	sigs.k8s.io/yaml v1.6.0 // indirect
	storj.io/common v0.0.0-20260629224719-ba1bff0a7846 // indirect
	storj.io/drpc v1.0.0 // indirect
	storj.io/eventkit v0.0.0-20260716074419-6861a92e2aa5 // indirect
	storj.io/infectious v0.0.2 // indirect
	storj.io/picobuf v0.0.4 // indirect
	storj.io/uplink v1.14.3 // indirect
	zombiezen.com/go/capnproto2 v2.18.0+incompatible // indirect
)

replace github.com/urfave/cli/v2 => github.com/ipostelnik/cli/v2 v2.3.1-0.20210324024421-b6ea8234fe3d

replace github.com/quic-go/quic-go => github.com/chungthuang/quic-go v0.45.1-0.20260529212404-a9fddf436fc4

// The built-in cloudflared reports errors to Sentry. The stub does nothing (tools/nosentry).
replace github.com/getsentry/sentry-go => ./tools/nosentry
