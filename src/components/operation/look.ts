import { type RouteName, routeOf, WINDOWS, type WindowLook } from '../../routes'

/** The look of the operation page in this window, from its route (WINDOWS in src/routes.ts). */
export function pageLook(): WindowLook {
    return routeOf(window.location.pathname).def?.look ?? WINDOWS.copy
}

/**
 * The name of this window's route ('copy', 'mount'), for text that names the window's operation
 * inside a sentence. Each such sentence is a whole message per route, because a language can't
 * build it from the window's title.
 */
export function pageName(): RouteName | undefined {
    return routeOf(window.location.pathname).name
}
