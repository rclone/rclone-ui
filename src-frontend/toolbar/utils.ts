import type { fetchMountList, fetchServeList } from '../lib/rclone/api'

export function formatServeInfo(serve: Awaited<ReturnType<typeof fetchServeList>>[number]): string {
    const parts = [`ID: ${serve.id}`, `Address: ${serve.addr}`]

    if (serve.params?.opt?.password) {
        parts.push(`Password: ${serve.params.opt.password}`)
    }

    if (serve.params?.type) {
        parts.push(`Type: ${serve.params.type.toUpperCase()}`)
    }
    if (serve.params?.fs) {
        parts.push(`Source: ${serve.params.fs}`)
    }

    return parts.join('\n')
}

export function formatServeLabel(
    serve: Awaited<ReturnType<typeof fetchServeList>>[number]
): string {
    const type = serve.params?.type?.toUpperCase() ?? 'SERVE'
    const fs = serve.params?.fs ?? 'unknown'
    return `${type} · ${fs} · ${serve.addr}`
}

export function formatMountLabel(
    mount: Awaited<ReturnType<typeof fetchMountList>>[number]
): string {
    return `MOUNT · ${mount.Fs} · ${mount.MountPoint}`
}
