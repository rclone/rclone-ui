import { ChevronDown, ChevronUp } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import type { BackendOption } from '../../../types/rclone'
import RemoteField from '../RemoteField'
import type { RemoteValues } from './useRemoteForm'

/**
 * A backend's fields as both remote drawers lay them out: the ordinary ones, then the
 * advanced ones behind "More Options". `values` is what the fields start from (the saved
 * remote in Edit, the draft in Create); every change goes to `setValues`.
 */
export default function RemoteFields({
    fields,
    values,
    setValues,
    disabledFields = [],
    showMore,
    onToggleMore,
}: {
    fields: { normal: BackendOption[]; advanced: BackendOption[] }
    values: RemoteValues
    setValues: Dispatch<SetStateAction<RemoteValues>>
    disabledFields?: readonly string[]
    showMore: boolean
    onToggleMore: () => void
}) {
    return (
        <>
            {fields.normal.map((opt) => (
                <RemoteField
                    key={opt.Name}
                    option={opt}
                    config={values}
                    setConfig={setValues}
                    isDisabled={disabledFields.includes(opt.Name)}
                />
            ))}

            {fields.advanced.length > 0 && (
                <div className="pt-4">
                    <button
                        type="button"
                        onClick={onToggleMore}
                        className="flex items-center space-x-2 text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                    >
                        {showMore ? (
                            <ChevronUp className="w-4 h-4" />
                        ) : (
                            <ChevronDown className="w-4 h-4" />
                        )}
                        <span>More Options</span>
                    </button>

                    {showMore && (
                        <div className="flex flex-col gap-4 pt-4 mt-4">
                            {fields.advanced.map((opt) => (
                                <RemoteField
                                    key={opt.Name}
                                    option={opt}
                                    config={values}
                                    setConfig={setValues}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </>
    )
}
