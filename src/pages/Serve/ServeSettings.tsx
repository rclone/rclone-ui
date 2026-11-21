import { t } from '@lingui/core/macro'
import { Kind, type Option } from '../../../lib/catalog'
import CommonSettings, { SettingText } from '../../components/operation/CommonSettings'
import type { BoundGroup } from '../../components/operation/optionBinding'
import { defaultValue } from '../../components/optionValues'

/** Returns an option's default value, written the way it would be typed in its field. */
function defaultText(option: Option): string {
    const value = defaultValue(option)
    return Array.isArray(value) ? value.join(', ') : value
}

/**
 * The common settings of a serve, limited to the ones its type supports: the address it listens
 * on, and the username and password that clients must use. Renders nothing for a type that has
 * none of them (DLNA has no login).
 */
export default function ServeSettings({
    group,
    options,
}: {
    group: BoundGroup
    /** The serve type's options, from the catalog. */
    options: readonly Option[]
}) {
    const addr = options.find((option) => option.name === 'addr')
    const user = options.find((option) => option.name === 'user')
    const pass = options.find((option) => option.name === 'pass')
    if (!addr && !user && !pass) return null
    return (
        <CommonSettings title={user || pass ? t`Address and sign-in` : t`Address`}>
            {addr && (
                <div className="col-span-2">
                    <SettingText
                        group={group}
                        name="addr"
                        label={t`Address`}
                        help={t`Where it listens: 127.0.0.1:8080 is reachable from this computer only, :8080 from your network too.`}
                        placeholder={defaultText(addr)}
                        list={addr.kind === Kind.KindList}
                    />
                </div>
            )}
            {user && (
                <SettingText
                    group={group}
                    name="user"
                    label={t`Username`}
                    help={t`Asked of whoever connects, with the password.`}
                />
            )}
            {pass && <SettingText group={group} name="pass" label={t`Password`} type="password" />}
        </CommonSettings>
    )
}
