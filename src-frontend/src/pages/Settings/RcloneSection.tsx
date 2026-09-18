import BaseSection from './BaseSection'
import { BinarySettings } from './BinarySection'
import { ProxySettings } from './ProxySection'

// The browser's one screen for the rclone the server runs: the binary settings and the proxy
// settings, which the desktop window keeps as two tabs of right-aligned labels. A tab is wide, so
// here the same groups are a centred column of cards with full-width controls.
export default function RcloneSection() {
    return (
        <BaseSection
            header={{ title: 'Rclone' }}
            className="w-full max-w-3xl gap-4 px-6 pb-12 mx-auto"
        >
            <BinarySettings layout="web" />
            <ProxySettings layout="web" />
        </BaseSection>
    )
}
