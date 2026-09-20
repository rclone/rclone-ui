// What the daemon has up right now, for the Dashboard's counters: a failure reads as nothing.

import rclone from '@/lib/rclone/client'

export async function fetchServeList() {
    try {
        const response = await rclone('/serve/list')
        return response.list
    } catch (error) {
        console.error('[fetchServeList] failed to fetch active serves', error)
        return []
    }
}

export async function fetchMountList() {
    try {
        const response = await rclone('/mount/listmounts')
        return response.mountPoints
    } catch (error) {
        console.error('[fetchMountList] failed to fetch active mounts', error)
        return []
    }
}
