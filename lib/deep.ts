import { emitTo } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { ADD_TEMPLATE, type AddTemplatePayload } from './events'
import { openWindow } from './window'

const TEMPLATES_WINDOW = 'Templates'

export function getDeepLinkUrl(url: string) {
    let cleanedUrl = url.replace('rclone:', '')
    while (cleanedUrl.startsWith('/')) {
        cleanedUrl = cleanedUrl.slice(1)
    }
    return cleanedUrl
}

export async function handleDeepLinkUrl(url: string) {
    console.log('deep link url', url)

    // `add-template?cmd=…` — split the query off before matching the route, and tolerate a
    // trailing slash (`add-template/?cmd=…`) that some platforms add.
    const queryIndex = url.indexOf('?')
    const route = queryIndex === -1 ? url : url.slice(0, queryIndex)
    const params = new URLSearchParams(queryIndex === -1 ? '' : url.slice(queryIndex + 1))
    const domain = route.split('/')[0]

    try {
        if (domain === 'add-template') {
            const payload: AddTemplatePayload = {
                cmd: params.get('cmd')?.trim() || undefined,
                name: params.get('name')?.trim() || undefined,
            }

            // open_window only focuses an existing window (it never re-navigates), so a live
            // Templates window gets the payload over the event bus instead of the URL.
            const existing = await WebviewWindow.getByLabel(TEMPLATES_WINDOW)
            if (existing) {
                await emitTo(TEMPLATES_WINDOW, ADD_TEMPLATE, payload)
                await openWindow({ name: TEMPLATES_WINDOW, url: '/templates' })
                return
            }

            const search = new URLSearchParams({ action: 'add' })
            if (payload.cmd) search.set('cmd', payload.cmd)
            if (payload.name) search.set('name', payload.name)
            await openWindow({ name: TEMPLATES_WINDOW, url: `/templates?${search}` })
        }
    } catch (error) {
        console.error('[handleDeepLinkUrl] failed to handle deep link', error)
    }
}
