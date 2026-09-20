import { submit } from '@/lib/rclone/start'

/**
 * A download from a URL into `fs`, as `remote`: rclone's `operations/copyurl`, as a batch of one
 * input so that it starts where every other transfer does and is recorded like one.
 */
export async function startDownload({
    url,
    fs,
    remote,
}: { url: string; fs: string; remote: string }) {
    return submit(
        {
            endpoint: '/job/batch',
            body: {
                inputs: [{ _path: 'operations/copyurl', fs, remote, url, autoFilename: false }],
                _async: true,
            },
        },
        {
            operation: 'download',
            sources: [url],
            destination: /[/\\:]$/.test(fs) ? `${fs}${remote}` : `${fs}/${remote}`,
        }
    )
}

