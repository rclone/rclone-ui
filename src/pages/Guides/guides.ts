import { t } from '@lingui/core/macro'
import {
    ArrowsRotate as ArrowsRotateIcon,
    Bell as BellIcon,
    Clock as ClockIcon,
    Compass as CompassIcon,
    DownloadBracket as DownloadBracketIcon,
    FolderConnection as FolderConnectionIcon,
    HardDrive as HardDriveIcon,
    Inbox as InboxIcon,
    LayerGroup as LayerGroupIcon,
    Layout1 as Layout1Icon,
    Mobile as MobileIcon,
    PlayCircle as PlayCircleIcon,
    PowerOff as PowerIcon,
    Search as SearchIcon,
    ServerSimple as ServerSimpleIcon,
    Share as ShareIcon,
    SparklesAi as SparklesAiIcon,
    TowerBroadcast as TowerBroadcastIcon,
} from '@zappicon/react'
import { foldCase } from '../../../lib/format'
import type { Platform } from '../../../lib/shell'
import { plainText } from './text'
import type { Guide } from './types'

// The guides. Each one names the labels the user sees in the app in **bold**, so the steps can
// be followed with the window open. A step's button opens the window it talks about.
// guides.test.ts checks that every route and every related guide exists.
//
// Each title, paragraph, step and tip is one message, with its markup inside (text.tsx), so that
// a translator can move a label or a key within the sentence. A label in bold names a button of
// another window, and its translation is that window's. Typed text, in backticks, stays as it is.

export const GUIDES: Guide[] = [
    // Getting started
    {
        id: 'launcher',
        category: 'start',
        title: t`The launcher`,
        summary: t`Press [[shortcut]] in any app to find a remote, a folder, an operation or a window.`,
        icon: SearchIcon,
        keywords: {
            english: ['shortcut', 'search', 'command palette', 'keyboard'],
            translated: [t`shortcut`, t`search`, t`command palette`, t`keyboard`],
        },
        sections: [
            {
                title: t`Open it and type`,
                text: [
                    t`The launcher is the fastest way around Rclone UI. It opens over whatever you are doing, and closes again when you pick something.`,
                ],
                steps: [
                    {
                        text: t`Press [[shortcut]]. The launcher opens with your recent picks first.`,
                    },
                    {
                        text: t`Type a few letters of what you want: a remote (\`gdrive\`), a window (\`schedules\`), an operation (\`sync\`), or a path (\`gdrive:Photos\`, \`~/Documents\`).`,
                    },
                    {
                        text: t`Use ↑ and ↓ to choose a row, then press Enter. [[key:1]] to [[key:9]] pick a row straight away.`,
                    },
                ],
                tips: [
                    t`To change the shortcut, open **Settings**, then **Record shortcut** in the Launcher group.`,
                ],
            },
            {
                title: t`Do more with a row`,
                text: [
                    t`A remote, a folder or a file has more actions than the one Enter runs. Press [[key:K]] to see them all: **Browse**, **Copy From**, **Sync From**, **Mount**, **Serve**, **Copy Path** and more.`,
                    t`Press Tab on a remote or a folder to go into it, and keep typing to go deeper. The launcher lists the folders as you type.`,
                ],
            },
            {
                title: t`Paths, links and dropped files`,
                text: [
                    t`Type two paths, such as \`~/Photos gdrive:Backup\`, and the launcher offers to copy, move, sync or bisync from the first to the second.`,
                    t`Paste a link and it offers to download it. When you have just copied a link or a path, the launcher suggests it before you type anything.`,
                    t`Drop files from your file manager onto the launcher, then type where they should go, or pick a remote.`,
                ],
            },
        ],
        related: ['wizard', 'remotes'],
    },
    {
        id: 'remotes',
        category: 'start',
        title: t`Connect your storage`,
        summary: t`Add a cloud drive, a bucket or a server once, then browse, copy and mount it from anywhere.`,
        icon: ServerSimpleIcon,
        open: { label: t`Open Remotes`, route: '/remotes' },
        keywords: {
            english: [
                'remote',
                'add',
                'google drive',
                'dropbox',
                's3',
                'sign in',
                'oauth',
                'config',
            ],
            translated: [t`remote`, t`add`, t`sign in`, t`config`],
        },
        sections: [
            {
                title: t`Add a remote`,
                text: [
                    t`A remote is storage you connect once: Google Drive, Dropbox, OneDrive, an S3 bucket, an SFTP server and more than seventy others.`,
                ],
                steps: [
                    {
                        text: t`Open the Remotes window and press **New remote** at the top right.`,
                        action: { label: t`Open Remotes`, route: '/remotes' },
                    },
                    {
                        text: t`Give it a **Name** you will recognize, like \`gdrive\`, and pick its type.`,
                    },
                    {
                        text: t`Fill in what the type asks for, then press **Create remote**. For a service you sign in to, your browser opens: sign in there, and the remote is ready.`,
                    },
                ],
                tips: [
                    t`The remote’s name is how you write paths on it: \`gdrive:Photos/2024\` is the folder Photos/2024 on the remote gdrive.`,
                ],
            },
            {
                title: t`Keep it working`,
                text: [
                    t`Each card shows whether the remote is **Connected**, and its free and used space when the service reports them.`,
                    t`When a sign-in expires, Rclone UI asks you to reconnect. You can also choose **Reconnect** in the card’s menu at any time.`,
                    t`To rename a remote, change its **Name** in its editor. Its favorites, templates and mount settings follow.`,
                ],
                tips: [
                    t`Remotes are saved in rclone’s own config file, which the rclone command in your terminal uses too. **Config file**, at the top of the window, can encrypt it with a password.`,
                ],
            },
        ],
        related: ['commander', 'copy-move-sync'],
    },
    {
        id: 'wizard',
        category: 'start',
        title: t`Not sure where to start?`,
        summary: t`Answer a few questions, and the Wizard finds the operation for what you want to do.`,
        icon: CompassIcon,
        open: { label: t`Open the Wizard`, route: '/wizard' },
        keywords: {
            english: ['run operation', 'wizard', 'help', 'which'],
            translated: [t`run operation`, t`wizard`, t`help`, t`which`],
        },
        sections: [
            {
                title: t`Let the Wizard choose`,
                steps: [
                    {
                        text: t`Open the launcher with [[shortcut]] and choose **Run**, or use the button below.`,
                        action: { label: t`Open the Wizard`, route: '/wizard' },
                    },
                    {
                        text: t`Say what you want to do: copy or move files, keep two places the same, mount a drive, share a folder, download a link, or delete files.`,
                    },
                    {
                        text: t`Answer the questions that follow: which places, whether metadata comes along, when it should run, and whether to save the settings as a template.`,
                    },
                    {
                        text: t`Look over your plan, then open the operation. Nothing runs until you start it there.`,
                    },
                ],
                tips: [
                    t`A sentence at the top fills in as you answer, so you can check the plan in plain words before you start.`,
                ],
            },
        ],
        related: ['copy-move-sync', 'schedules'],
    },

    // Moving files
    {
        id: 'copy-move-sync',
        category: 'files',
        title: t`Copy, move and sync`,
        summary: t`Which one to choose, and where your files end up.`,
        icon: ArrowsRotateIcon,
        open: { label: t`Open Copy`, route: '/copy' },
        keywords: {
            english: ['copy', 'move', 'sync', 'bisync', 'transfer', 'backup', 'dry run', 'preview'],
            translated: [
                t`copy`,
                t`move`,
                t`sync`,
                t`bisync`,
                t`transfer`,
                t`backup`,
                t`dry run`,
                t`preview`,
            ],
        },
        sections: [
            {
                title: t`Choose the operation`,
                text: [
                    t`**Copy** puts files into the destination and skips the ones already there. Nothing is ever deleted.`,
                    t`**Move** does the same, then removes each file from the source once it has arrived.`,
                    t`**Sync** makes the destination match the source. Files that are only in the destination are deleted.`,
                    t`**Bisync** keeps two places alike both ways. What changed on either side is copied to the other.`,
                ],
            },
            {
                title: t`Where the files land`,
                text: [
                    t`Copy and Move put each folder you pick inside the destination, under its own name: copying \`~/Desktop/Trip\` to \`gdrive:Photos\` gives \`gdrive:Photos/Trip\`. You can pick several folders and files at once.`,
                    t`Sync and Bisync work on the contents. Syncing \`~/Desktop/Trip\` to \`gdrive:Photos/Trip\` makes \`gdrive:Photos/Trip\` match it.`,
                ],
                tips: [
                    t`Copy and Move show where everything lands under **Destination**, before you start.`,
                ],
            },
            {
                title: t`Start safely`,
                steps: [
                    {
                        text: t`Fill in **Source** and **Destination**. Type a path, or press the folder button next to the field to pick one.`,
                        action: { label: t`Open Copy`, route: '/copy' },
                    },
                    {
                        text: t`Not sure what will happen? Open the **More** menu at the top right and choose **Preview**, a dry run: it shows what would be copied or deleted, in History, without changing anything.`,
                    },
                    {
                        text: t`Press **Start copy**, or the start button of the operation you chose. Sync asks before it deletes anything, and offers a dry run first.`,
                    },
                ],
                tips: [
                    t`The first bisync of two folders sets a baseline: Rclone UI asks before it does, and nothing is deleted then.`,
                ],
            },
        ],
        related: ['history', 'templates', 'schedules'],
    },
    {
        id: 'commander',
        category: 'files',
        title: t`Browse with Commander`,
        summary: t`Two panels side by side, to browse your remotes and this computer, and move files between them.`,
        icon: Layout1Icon,
        open: { label: t`Open Commander`, route: '/commander' },
        keywords: {
            english: [
                'browse',
                'explorer',
                'files',
                'panels',
                'drag',
                'rename',
                'delete',
                'preview',
            ],
            translated: [
                t`browse`,
                t`explorer`,
                t`files`,
                t`panels`,
                t`drag`,
                t`rename`,
                t`delete`,
                t`preview`,
            ],
        },
        sections: [
            {
                title: t`Find your way around`,
                text: [
                    t`Each panel has its own places in the sidebar next to it: your favorites (the star), the disks and folders on this computer, and your remotes.`,
                    t`Click a folder to open it, and the back arrow at the top of the panel to go up. Click a name in the path to jump there, or the pencil, **Edit path**, to type one.`,
                    t`Click a file to preview it: photos, videos, PDFs, documents and text open without downloading them first.`,
                ],
            },
            {
                title: t`Copy and move files`,
                steps: [
                    {
                        text: t`Open the source in one panel and the destination in the other.`,
                        action: { label: t`Open Commander`, route: '/commander' },
                    },
                    {
                        text: t`Tick the files and folders to take, or just start with one.`,
                    },
                    {
                        text: t`Drag them onto the other panel, then choose **Copy** or **Move** and confirm.`,
                    },
                    {
                        text: t`Follow the progress in the bar at the bottom. **Open History** shows every transfer in full.`,
                    },
                ],
            },
            {
                title: t`Work on a file or a folder`,
                text: [
                    t`Hover a row to see its buttons: the star adds a folder to your favorites, then download, share, rename and delete.`,
                    t`**New folder**, at the top right of a panel, makes a folder. To rename many files at once, select them and press **Batch Rename** in the bottom bar.`,
                    t`**Compare** in the bottom bar puts the two open folders side by side, and shows what is only on one side.`,
                    t`**Disk Usage** in the bottom bar shows what takes up space on a whole remote or disk, largest first. Pick one of the two open panels, and the results come in while it scans.`,
                ],
            },
            {
                title: t`Search`,
                text: [
                    t`Type in **Type here to search** to filter the folder you are in. Tick **Search in sub-folders** to look through every folder below it.`,
                ],
                tips: [
                    t`Large folders on S3 and Swift open faster without file dates. Turn **File dates** on or off with the cog, **Panel settings**, at the bottom left.`,
                ],
            },
        ],
        related: ['public-links', 'copy-move-sync'],
    },
    {
        id: 'public-links',
        category: 'files',
        title: t`Share a public link`,
        summary: t`Get a link to a file or a folder on a remote, for anyone to open without an account.`,
        icon: ShareIcon,
        open: { label: t`Open Commander`, route: '/commander' },
        keywords: {
            english: ['link', 'share', 'url', 'public', 'send'],
            translated: [t`link`, t`share`, t`public`, t`send`],
        },
        sections: [
            {
                title: t`Copy a link`,
                steps: [
                    {
                        text: t`Open Commander and go to the file or folder on your remote.`,
                        action: { label: t`Open Commander`, route: '/commander' },
                    },
                    {
                        text: t`Hover its row and press the share button.`,
                    },
                    {
                        text: t`The link is copied, and **Link Copied** confirms it. Paste it in a message or an email.`,
                    },
                ],
                tips: [
                    t`The share button shows on remotes that can make links, such as Google Drive, Dropbox and OneDrive. Files on this computer have none: to share those, upload them first, or serve their folder.`,
                    t`Anyone who has the link can open it. Links made here don’t expire: to stop sharing, remove the link in the service itself.`,
                ],
            },
        ],
        related: ['serve', 'commander'],
    },
    {
        id: 'download',
        category: 'files',
        title: t`Download from a link`,
        summary: t`Save a file from the web straight to a remote or a folder, including videos from many sites.`,
        icon: DownloadBracketIcon,
        open: { label: t`Open Download`, route: '/download' },
        keywords: {
            english: ['url', 'youtube', 'instagram', 'tiktok', 'video', 'web'],
            translated: [t`video`, t`web`],
        },
        sections: [
            {
                title: t`Download a link`,
                steps: [
                    {
                        text: t`Copy the link, then open Download and press **Paste** next to **Link**.`,
                        action: { label: t`Open Download`, route: '/download' },
                    },
                    {
                        text: t`Under **Save to**, choose a folder on this computer or on a remote.`,
                    },
                    {
                        text: t`Check the **Filename**, including the extension, then press **Download**.`,
                    },
                ],
                tips: [
                    t`For a page on Instagram, TikTok, YouTube, X and other sites, the video, image or audio on it is downloaded, and a preview shows before you start.`,
                    t`You can also paste a link into the launcher and it will help you download it.`,
                ],
            },
        ],
        related: ['launcher', 'history'],
    },
    {
        id: 'history',
        category: 'files',
        title: t`History and retries`,
        summary: t`Follow every transfer, see what failed, and run it again.`,
        icon: InboxIcon,
        open: { label: t`Open History`, route: '/history' },
        keywords: {
            english: ['transfers', 'progress', 'failed', 'retry', 'log', 'jobs'],
            translated: [t`transfers`, t`progress`, t`failed`, t`retry`, t`log`, t`jobs`],
        },
        sections: [
            {
                title: t`Follow a transfer`,
                text: [
                    t`Every copy, move, sync, bisync and delete shows in History. They are kept after a restart.`,
                    t`Use **Running**, **Failed** and the other tabs, or search by number, path or error. Click a transfer to see each file.`,
                ],
            },
            {
                title: t`When something fails`,
                steps: [
                    {
                        text: t`Open the transfer in History.`,
                        action: { label: t`Open History`, route: '/history' },
                    },
                    {
                        text: t`Press **Retry failed** to choose the files to try again, or **Reuse settings** to open the operation with the same paths and options.`,
                    },
                ],
            },
        ],
        related: ['copy-move-sync', 'notifications'],
    },
    {
        id: 'templates',
        category: 'files',
        title: t`Save and reuse settings`,
        summary: t`Keep the paths and options of an operation, and use them again in one click.`,
        icon: LayerGroupIcon,
        open: { label: t`Open Templates`, route: '/templates' },
        keywords: {
            english: ['preset', 'reuse', 'options', 'flags', 'gallery'],
            translated: [t`preset`, t`reuse`, t`options`, t`flags`, t`gallery`],
        },
        sections: [
            {
                title: t`Save a template`,
                steps: [
                    {
                        text: t`On an operation page, fill in the paths and the options you want to keep.`,
                    },
                    {
                        text: t`Press **Templates** at the top right of the page, then **Save as template**, and name it.`,
                    },
                ],
            },
            {
                title: t`Use a template`,
                text: [
                    t`On an operation page, pick the template in the same menu. Choose **Add to Existing** to merge it with what you entered, or **Replace All**.`,
                    t`In the Templates window, a template with paths has a **Run** button, and the clock button schedules it.`,
                ],
                tips: [
                    t`The gallery has ready-made templates. You can also paste an rclone command under **Start from a command** when you add a template.`,
                ],
            },
        ],
        related: ['schedules', 'copy-move-sync'],
    },

    // Automating
    {
        id: 'schedules',
        category: 'automate',
        title: t`Schedule a backup`,
        summary: t`Run a copy, a sync or another operation by itself, for example every night.`,
        icon: ClockIcon,
        open: { label: t`Open Schedules`, route: '/schedules' },
        keywords: {
            english: ['cron', 'every day', 'nightly', 'backup', 'automatic', 'timer'],
            translated: [t`every day`, t`nightly`, t`backup`, t`automatic`, t`timer`],
        },
        sections: [
            {
                title: t`Create a schedule`,
                steps: [
                    {
                        text: t`Open the operation, such as Sync, and fill in its paths and options as for a single run.`,
                        action: { label: t`Open Sync`, route: '/sync' },
                    },
                    { text: t`Press **Schedule**, beside the start button at the bottom.` },
                    {
                        text: t`Name it, and choose **When**: every hour, every day, every weekday, every week, every month, or a cron expression. The next runs show under it.`,
                    },
                    { text: t`Press **Create schedule**.` },
                ],
                tips: [
                    t`Copy, Move, Sync, Bisync, Delete and Purge can be scheduled. A template can be scheduled from the Templates window too.`,
                ],
            },
            {
                title: t`Manage your schedules`,
                text: [
                    t`The Schedules window lists them with their next run and their last result. The switch pauses one, and the play button, **Run now**, runs it at once.`,
                    t`In a schedule’s menu, **Edit** changes its name and time. **Edit the operation** opens the operation’s window to change its paths and options.`,
                    t`Each run shows in History, and a failed run tells you on the desktop and through your notifications.`,
                ],
            },
            {
                title: t`Keep it running`,
                text: [
                    t`Schedules run only while Rclone UI is running, even with its windows closed. A time missed while it was closed runs once, a minute after it starts again.`,
                    t`If a run is still going when the next one is due, that time is skipped.`,
                ],
                tips: [
                    t`Turn on **Start at login** so that schedules run after you restart your computer. The Schedules window offers it.`,
                ],
            },
        ],
        related: ['watchers', 'notifications', 'background'],
    },
    {
        id: 'watchers',
        category: 'automate',
        title: t`Keep folders in sync`,
        summary: t`A watcher keeps two folders alike both ways, like Dropbox: on this computer, a remote, or both.`,
        icon: FolderConnectionIcon,
        open: { label: t`Open Watchers`, route: '/watchers' },
        keywords: {
            english: ['bisync', 'dropbox', 'mirror', 'two-way', 'keep in sync'],
            translated: [t`bisync`, t`mirror`, t`two-way`, t`keep in sync`],
        },
        sections: [
            {
                title: t`Create a watcher`,
                steps: [
                    {
                        text: t`Open Watchers and press **New watcher**.`,
                        action: { label: t`Open Watchers`, route: '/watchers' },
                    },
                    {
                        text: t`Name it, and pick **Folder A** and **Folder B**. Either can be on this computer or on a remote.`,
                    },
                    {
                        text: t`Press **Create watcher**. The first sync merges the two folders: missing files are copied over, the newer of two versions is kept, and nothing is deleted.`,
                    },
                ],
            },
            {
                title: t`How it works`,
                text: [
                    t`Every minute, what changed in either folder is copied to the other, including deletions. **Sync now** runs it at once, and the switch pauses it.`,
                    t`If many files were deleted on one side, the watcher stops to make sure that was intended. You can then delete them in the other folder too, or bring them back.`,
                ],
                tips: [
                    t`Like schedules, watchers run only while Rclone UI is running or in the background. Turn on **Start at login** to keep them going.`,
                ],
            },
        ],
        related: ['schedules', 'background'],
    },
    {
        id: 'background',
        category: 'automate',
        title: t`Run in the background`,
        summary: t`Keep schedules, watchers and automounts going: start Rclone UI when you log in.`,
        icon: PowerIcon,
        open: { label: t`Open Settings`, route: '/settings' },
        keywords: {
            english: ['start at login', 'startup', 'tray', 'menu bar', 'dock', 'quit'],
            translated: [t`start at login`, t`startup`, t`tray`, t`menu bar`, t`dock`, t`quit`],
        },
        sections: [
            {
                title: t`Start at login`,
                steps: [
                    {
                        text: t`Open Settings, and turn on **Start at login** in the Startup group.`,
                        action: { label: t`Open Settings`, route: '/settings' },
                    },
                ],
                text: [
                    t`Rclone UI keeps running when you close its windows. Its icon stays in the menu bar or the system tray, where you can open Rclone UI, follow running transfers, and open or stop mounts and serves.`,
                ],
            },
            {
                title: t`Hide it from the Dock`,
                os: ['macos'],
                text: [
                    t`**Hide from Dock**, in the Appearance group of Settings, keeps Rclone UI in the menu bar only.`,
                ],
            },
            {
                title: t`Quitting`,
                text: [
                    t`When you quit, Rclone UI stops its transfers, mounts and serves, and says which schedules and watchers stop with it. Automounts come back at the next start.`,
                ],
            },
        ],
        related: ['schedules', 'automounts'],
    },
    {
        id: 'agents',
        category: 'automate',
        title: t`Use it from an AI agent`,
        summary: t`Ask Claude Code, Claude Desktop or Cursor to find, copy and sync your files for you.`,
        icon: SparklesAiIcon,
        open: { label: t`Open Settings`, route: '/settings?section=agents' },
        keywords: {
            english: [
                'ai',
                'agent',
                'mcp',
                'model context protocol',
                'claude',
                'claude code',
                'claude desktop',
                'cursor',
                'llm',
                'assistant',
                'chat',
            ],
            translated: [t`ai`, t`agent`, t`assistant`, t`chat`],
        },
        sections: [
            {
                title: t`What it does`,
                text: [
                    t`An AI agent, such as Claude Code or Cursor, can use Rclone UI over MCP: it browses your remotes, and starts the same copies, syncs and mounts that you start in the windows. It is off until you turn it on, and only apps on this computer can connect.`,
                ],
            },
            {
                title: t`Turn it on and connect`,
                steps: [
                    {
                        text: t`Open Settings, and turn on **Let AI agents use Rclone UI** in the Agents group.`,
                        action: { label: t`Open Settings`, route: '/settings?section=agents' },
                    },
                    {
                        text: t`For Claude Code, copy the command under **Connect your agent**, then run it in a terminal.`,
                    },
                    {
                        text: t`For Claude Desktop, Cursor and other apps that start a command, pick **Claude Desktop, Cursor**, add what you copy to the app's MCP configuration, then restart the app.`,
                    },
                ],
                tips: [
                    t`An app that starts a command needs no token, and starts Rclone UI if it isn't running.`,
                ],
            },
            {
                title: t`Ask it`,
                text: [
                    t`Ask in your own words, for example: “Copy last month's photos from gdrive to my backup drive, and show me what would be deleted first.”`,
                    t`Before anything that deletes or overwrites files, Rclone UI asks the agent to preview it and tell you what would change. Your agent's app can also ask you before each change.`,
                ],
            },
            {
                title: t`See what it did`,
                steps: [
                    {
                        text: t`Open History. Every transfer that an agent starts shows there, with its app's name, such as Claude Code.`,
                        action: { label: t`Open History`, route: '/history' },
                    },
                ],
                tips: [
                    t`To cut off every app that connects by the address, press **New token** in Settings.`,
                ],
            },
        ],
        related: ['history', 'copy-move-sync'],
    },

    // Drives and sharing
    {
        id: 'mount',
        category: 'drives',
        title: t`Mount as a drive`,
        summary: t`Show a remote as a folder on this computer, so any app can open its files.`,
        icon: HardDriveIcon,
        open: { label: t`Open Mount`, route: '/mount' },
        keywords: {
            english: ['drive', 'finder', 'explorer', 'vfs', 'cache', 'fuse', 'winfsp'],
            translated: [t`drive`, t`explorer`, t`cache`],
        },
        sections: [
            {
                title: t`Mount it`,
                steps: [
                    {
                        text: t`Open Mount, and pick the **Remote path**. It can be the root of the remote, or a folder inside.`,
                        action: { label: t`Open Mount`, route: '/mount' },
                    },
                    {
                        text: t`Set the **Mount point** to an empty folder. Rclone UI suggests one, and creates the folder if it doesn't exist.`,
                        os: ['macos', 'linux'],
                    },
                    {
                        text: t`Set the **Mount point** to a drive letter like \`M:\`, or leave it empty to use the next free one.`,
                        os: ['windows'],
                    },
                    {
                        text: t`Choose the **Cache**. With **Writes**, apps can save files. **Full** also keeps the files you open on this computer, for speed. With **Off**, most apps can open files but not save them.`,
                    },
                    { text: t`Press **Start mount**, then **Open** to see your files.` },
                ],
            },
            {
                title: t`What your computer needs`,
                text: [
                    t`Windows needs WinFsp. The Rclone UI installer adds it when you install as an administrator, and the Mount page offers to install it when it is missing.`,
                    // WinFsp's notice, which its license asks for, stays as it is in every language.
                    'WinFsp - Windows File System Proxy, Copyright (C) Bill Zissimopoulos: `https://github.com/winfsp/winfsp`',
                ],
                os: ['windows'],
            },
            {
                title: t`What your computer needs`,
                text: [
                    t`macOS needs nothing extra. Rclone UI mounts through the system’s own NFS client.`,
                ],
                os: ['macos'],
            },
            {
                title: t`What your computer needs`,
                text: [t`Linux needs FUSE.`],
                os: ['linux'],
            },
            {
                title: t`Unmount`,
                text: [
                    t`Running mounts are listed on the Mount page, in the menu bar or tray icon’s menu under **Mounts**, and at the top of the launcher. Each has **Open** and **Unmount**.`,
                    t`A mount you start here stops when Rclone UI quits. To mount every time it starts, use an automount.`,
                ],
            },
        ],
        related: ['automounts', 'serve'],
    },
    {
        id: 'automounts',
        category: 'drives',
        title: t`Mount at startup`,
        summary: t`Mount a remote each time Rclone UI starts, at the same place every time.`,
        icon: PlayCircleIcon,
        open: { label: t`Open Automounts`, route: '/automounts' },
        keywords: {
            english: ['automount', 'mount at login', 'startup', 'drive'],
            translated: [t`automount`, t`mount at login`, t`startup`, t`drive`],
        },
        sections: [
            {
                title: t`Add an automount`,
                steps: [
                    {
                        text: t`Open Automounts and press **New automount**.`,
                        action: { label: t`Open Automounts`, route: '/automounts' },
                    },
                    {
                        text: t`Choose the **Remote**, and a **Folder** in it, or leave the folder empty for the whole remote.`,
                    },
                    {
                        text: t`Choose the **Mount point**, then press **Add automount**. It mounts the next time Rclone UI starts.`,
                    },
                    {
                        text: t`To mount it now, press **Mount now**, the play button on its row.`,
                    },
                ],
                tips: [
                    t`A remote can have several automounts, each with its own folder and mount point.`,
                    t`In the launcher, a remote’s actions include **New automount**, which fills in the remote for you.`,
                ],
            },
            {
                title: t`When a remote can’t be reached`,
                text: [
                    t`If the network or the sign-in is down when Rclone UI starts, it tries for about a minute, then skips the mount and tells you. That way an empty folder never takes the place of your files.`,
                    t`**Mount now** mounts it once the remote is back.`,
                ],
                tips: [
                    t`Turn on **Start at login**, so that your automounts are there after you restart your computer.`,
                ],
            },
        ],
        related: ['mount', 'background'],
    },
    {
        id: 'serve',
        category: 'drives',
        title: t`Share a folder on your network`,
        summary: t`Serve a folder over HTTP, WebDAV, SFTP and more, for other devices and apps to open.`,
        icon: TowerBroadcastIcon,
        open: { label: t`Open Serve`, route: '/serve' },
        keywords: {
            english: [
                'serve',
                'webdav',
                'http',
                'sftp',
                'ftp',
                'dlna',
                'nfs',
                's3',
                'restic',
                'network',
            ],
            translated: [t`serve`, t`network`],
        },
        sections: [
            {
                title: t`Serve a folder`,
                steps: [
                    {
                        text: t`Open Serve, and pick the **Source**. It can be a folder on a remote or on this computer.`,
                        action: { label: t`Open Serve`, route: '/serve' },
                    },
                    {
                        text: t`Under **Type**, choose how it’s served. **WebDAV** opens in Finder and File Explorer, **HTTP** in a browser, and **DLNA** on TVs and media players.`,
                    },
                    {
                        text: t`Set the **Address**. \`127.0.0.1:8080\` is reachable from this computer only, \`:8080\` from your network too. Add a **Username** and **Password** to keep others out.`,
                    },
                    { text: t`Press **Start serve**, then **Copy address** to share it.` },
                ],
                tips: [
                    t`Running serves are listed on the Serve page, in the menu bar or tray icon’s menu under **Serves**, and in the launcher, each with **Stop**.`,
                ],
            },
        ],
        related: ['public-links', 'mount'],
    },

    // Staying informed
    {
        id: 'notifications',
        category: 'app',
        title: t`Get notified`,
        summary: t`Hear about failed transfers, mounts and watchers on Slack, Discord, Telegram, email or any webhook.`,
        icon: BellIcon,
        open: { label: t`Open Notifications`, route: '/notifications' },
        keywords: {
            english: ['alerts', 'slack', 'discord', 'telegram', 'email', 'smtp', 'webhook'],
            translated: [t`alerts`, t`email`, t`webhook`],
        },
        sections: [
            {
                title: t`Add a notification`,
                steps: [
                    {
                        text: t`Open Notifications, and pick where the messages should go, such as **Discord** or **Email**.`,
                        action: { label: t`Open Notifications`, route: '/notifications' },
                    },
                    {
                        text: t`Paste its webhook URL. For Telegram, paste the **Bot token** from BotFather and your **Chat ID**. For email, enter the addresses to send to.`,
                    },
                    {
                        text: t`Choose the **Events** to hear about, such as **Transfer failed**, then press **Send test** to check it arrives.`,
                    },
                ],
                tips: [
                    t`Email goes out through your own mail server. Set it up first with the envelope button, **Mail server**, at the top right.`,
                    t`Rclone UI shows failures on the desktop in any case. Notifications reach you anywhere else, such as on your phone.`,
                ],
            },
        ],
        related: ['schedules', 'history'],
    },
    {
        id: 'mobileRemoteControl',
        category: 'app',
        title: t`Use it from your phone`,
        summary: t`Manage rclone on this computer with the Rclone UI app on your phone.`,
        icon: MobileIcon,
        open: { label: t`Open Remote Control`, route: '/mobileRemoteControl' },
        keywords: {
            english: ['phone', 'ios', 'android', 'qr', 'tunnel', 'remote control'],
            translated: [t`phone`, t`tunnel`, t`remote control`],
        },
        sections: [
            {
                title: t`Connect your phone`,
                steps: [
                    {
                        text: t`Install Rclone UI on your phone from the App Store or Google Play.`,
                    },
                    {
                        text: t`Open Remote Control here and press **Tap to enable**.`,
                        action: { label: t`Open Remote Control`, route: '/mobileRemoteControl' },
                    },
                    {
                        text: t`Scan the QR code with the phone app. **Disable** ends the session.`,
                    },
                ],
                tips: [
                    t`What you start from the phone runs in the session’s own rclone. It doesn’t show in this app, and it ends when the session does.`,
                ],
            },
        ],
        related: ['launcher', 'remotes'],
    },
]

export function guideById(id: string): Guide | undefined {
    return GUIDES.find((g) => g.id === id)
}

/**
 * Every word of a guide that applies on `os`, for search. The search words are there in English
 * and in the app's language, so that English ones find a guide in every language.
 */
function words(guide: Guide, os: Platform): string {
    const sections = guide.sections.filter((s) => !s.os || s.os.includes(os))
    const all = [
        guide.title,
        guide.summary,
        ...(guide.keywords?.english ?? []),
        ...(guide.keywords?.translated ?? []),
        ...sections.flatMap((s) => [
            s.title,
            ...(s.text ?? []),
            ...(s.steps ?? []).filter((st) => !st.os || st.os.includes(os)).map((st) => st.text),
            ...(s.tips ?? []),
        ]),
    ]
        .map(plainText)
        .join('\n')
    return foldCase(all)
}

const RE_SPACES = /\s+/

/** Whether a guide mentions every word of the query. An empty query matches every guide. */
export function matches(guide: Guide, query: string, os: Platform): boolean {
    const terms = foldCase(query).split(RE_SPACES).filter(Boolean)
    if (terms.length === 0) return true
    const text = words(guide, os)
    return terms.every((term) => text.includes(term))
}
