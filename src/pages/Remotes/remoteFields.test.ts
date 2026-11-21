import { describe, expect, it } from 'vitest'
import type { Option } from '../../../lib/catalog'
import { shownValues } from './RemoteFields'

const option = (name: string) => ({ name }) as Option

describe('shownValues', () => {
    it('keeps only the values of the options that the form shows', () => {
        const values = { provider: 'Minio', storage_class: 'GLACIER', endpoint: 'x', chunk_size: 5 }
        const fields = {
            normal: [option('provider'), option('endpoint')],
            advanced: [option('chunk_size')],
        }
        expect(shownValues(values, fields)).toEqual({
            provider: 'Minio',
            endpoint: 'x',
            chunk_size: 5,
        })
    })
})
