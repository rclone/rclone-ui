import { BreadcrumbItem, Breadcrumbs, cn } from '@heroui/react'
import { LogOutIcon, PanelLeftIcon } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { authRequired } from '../../../lib/api/host'
import AppearanceMenu from './AppearanceMenu'
import { breadcrumbFor } from './nav'

const ICON_BUTTON =
    'flex items-center justify-center w-8 h-8 rounded-lg text-neutral-400 outline-none transition-colors duration-150 hover:bg-white/[0.06] hover:text-white focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-black'

// Both glyphs stay in the DOM and cross-fade (opacity, scale, blur) so the hover can reverse
// mid-way; reduced motion swaps them outright.
const SWAP =
    'transition-[opacity,transform,filter] duration-150 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none'

// The sticky site header above the sidebar and the page: the app icon, which turns into the
// sidebar toggle on hover; where you are; and the tab's own settings.
export default function SiteHeader({
    collapsed,
    onToggle,
}: {
    collapsed: boolean
    onToggle: () => void
}) {
    const location = useLocation()
    const navigate = useNavigate()
    const crumbs = breadcrumbFor(location)

    return (
        <header className="flex items-center h-14 gap-3 px-3 shrink-0 bg-black text-white select-none">
            <button
                type="button"
                onClick={onToggle}
                aria-label="Toggle sidebar"
                aria-expanded={!collapsed}
                className={cn(ICON_BUTTON, 'group relative')}
            >
                <img
                    src="/icon.png"
                    alt=""
                    className={cn(
                        'absolute w-5 h-5 rounded-[5px]',
                        SWAP,
                        'group-hover:opacity-0 group-hover:scale-[0.25] group-hover:blur-[4px] group-focus-visible:opacity-0 group-focus-visible:scale-[0.25] group-focus-visible:blur-[4px]'
                    )}
                />
                <PanelLeftIcon
                    className={cn(
                        'absolute w-4 h-4 opacity-0 scale-[0.25] blur-[4px]',
                        SWAP,
                        'group-hover:opacity-100 group-hover:scale-100 group-hover:blur-0 group-focus-visible:opacity-100 group-focus-visible:scale-100 group-focus-visible:blur-0'
                    )}
                    strokeWidth={1.75}
                />
            </button>
            <span className="w-px h-4 bg-white/15" aria-hidden="true" />
            <Breadcrumbs
                size="sm"
                itemClasses={{
                    item: 'text-[13px] text-neutral-400 data-[current=true]:text-white data-[current=true]:font-medium',
                    separator: 'text-neutral-600 px-1',
                }}
            >
                {crumbs.map((crumb, index) => (
                    <BreadcrumbItem key={crumb} isCurrent={index === crumbs.length - 1}>
                        {crumb}
                    </BreadcrumbItem>
                ))}
            </Breadcrumbs>
            <div className="flex items-center min-w-0 gap-1 ml-auto">
                <AppearanceMenu className={ICON_BUTTON} />
                {authRequired && (
                    <button
                        type="button"
                        onClick={async () => {
                            await fetch('/api/logout', {
                                method: 'POST',
                                credentials: 'same-origin',
                            })
                            navigate('/login', { replace: true })
                        }}
                        aria-label="Sign out"
                        title="Sign out"
                        className={ICON_BUTTON}
                    >
                        <LogOutIcon className="w-4 h-4" strokeWidth={1.75} />
                    </button>
                )}
            </div>
        </header>
    )
}
