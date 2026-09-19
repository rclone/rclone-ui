import { rcFetch } from '../api/rc'
import { getFsInfo } from '../format'

// Files on the machine the daemon runs on, through the daemon. rclone's rc sizes a local path
// like any remote, `--rc-serve` hands out a file's bytes and `operations/uploadfile` takes them
// back: one road for the app's own daemon and an external
// one. The UI server's own disk is never assumed to be the right one.

/** rclone's `fs` + `remote` pair for a local path (`:local:/` or `:local:C:/` roots, as the pages build them). */
export function localFs(path: string): { fs: string; remote: string } {
    const { root, filePath } = getFsInfo(path)
    return { fs: root, remote: filePath }
}

/** A path split the way the file endpoints want it: the folder as `fs`, the name inside it. */
function split(path: string): { dir: string; name: string } {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return { dir: cut > 0 ? path.slice(0, cut) : path.slice(0, cut + 1), name: path.slice(cut + 1) }
}

export async function readFile(path: string): Promise<string> {
    const { dir, name } = split(path)
    const response = await rcFetch(`[${encodeURIComponent(dir)}]/${encodeURIComponent(name)}`)
    if (!response.ok) {
        throw new Error(
            `rclone could not read ${path} (${response.status}). The daemon needs --rc-serve.`
        )
    }
    return response.text()
}

export async function writeFile(path: string, text: string): Promise<void> {
    const { dir, name } = split(path)
    const body = new FormData()
    body.append('file0', new File([text], name))
    const params = new URLSearchParams({ fs: dir, remote: '' })
    const response = await rcFetch(`operations/uploadfile?${params}`, {
        method: 'POST',
        body,
    })
    if (!response.ok) {
        throw new Error(`rclone could not write ${path} (${response.status}).`)
    }
}

async function rcJson<T>(
    path: string,
    body: Record<string, unknown>,
    init: RequestInit = {}
): Promise<T> {
    const response = await rcFetch(path, {
        ...init,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${path}: ${response.status}`)
    return (await response.json()) as T
}

// Size jobs still running for this page. A listing that is left stops its own; a page that is unloaded cannot, so the last thing it does is fire
// keep-alive stops for whatever is left.
const runningSizeJobs = new Set<number>()
if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
        for (const jobid of runningSizeJobs) {
            void rcJson('job/stop', { jobid }, { keepalive: true }).catch(() => null)
        }
    })
}

/**
 * Everything under a folder, added up by `operations/size` as a job the page waits on. rclone
 * takes the folder itself as the `fs` (there is no `remote` here: with one it would walk the
 * whole disk). A big tree takes as long as it takes, but no walk outlives its listing: the
 * caller's signal stops the job. The polling goes through the raw proxy, not the logged client.
 */
export async function folderSize(path: string, signal?: AbortSignal): Promise<number | undefined> {
    const { jobid } = await rcJson<{ jobid?: number }>('operations/size', {
        fs: `:local:${path}`,
        _async: true,
    })
    if (jobid === undefined) return undefined
    runningSizeJobs.add(jobid)
    try {
        while (!signal?.aborted) {
            const status = await rcJson<{
                finished?: boolean
                error?: string
                output?: { bytes?: number }
            }>('job/status', { jobid })
            if (status.finished) return status.error ? undefined : status.output?.bytes
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
    } catch {
        // Fall through to the stop: the job must not outlive a wait that failed.
    } finally {
        runningSizeJobs.delete(jobid)
    }
    await rcJson('job/stop', { jobid }).catch(() => null)
    return undefined
}
