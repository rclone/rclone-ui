// The one file the page reads from the UI server's own disk: its log. Every other file the
// pages touch lives where the daemon runs and goes through rclone (`lib/rclone/daemon-fs.ts`).

import { rpc } from './rpc'

export const readTail = (path: string, lines = 200) =>
    rpc<string[]>('fs_read_tail', { path, lines })
