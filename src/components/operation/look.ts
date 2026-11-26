import { type RouteName, routeOf, WINDOWS, type WindowLook } from '../../routes'

export function pageLook(): WindowLook {
    return routeOf(window.location.pathname).def?.look ?? WINDOWS.copy
}

export function pageName(): RouteName | undefined {
    return routeOf(window.location.pathname).name
}
