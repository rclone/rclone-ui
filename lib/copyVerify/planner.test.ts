import { describe, expect, it } from 'vitest'
import { type CopyArgs, buildCopyInputs, buildCopyRequests } from '../rclone/requests'
import { buildCopyVerifyPlan } from './planner'

function copyArgs(overrides: Partial<CopyArgs> = {}): CopyArgs {
    return {
        sources: ['/source/'],
        destination: '/destination/',
        options: { copy: {}, config: {}, filter: {}, remotes: {} },
        ...overrides,
    }
}

describe('buildCopyVerifyPlan', () => {
    it('shares the existing Copy fan-out byte-for-byte', () => {
        const args = copyArgs({ sources: ['/source/', '/source/nested.txt'] })
        const plan = buildCopyVerifyPlan(args)
        const copyRequest = buildCopyRequests(args)[0]

        expect(plan.copyInputs).toEqual(buildCopyInputs(args))
        expect(plan.copyInputs).toEqual(copyRequest.body.inputs)
        expect(plan.units).toHaveLength(1)
    })

    it('creates an exact, escaped file verification filter', () => {
        const plan = buildCopyVerifyPlan(
            copyArgs({
                sources: ['/source/price[1]*?.txt'],
                destination: '/destination/',
            })
        )

        expect(plan.units[0].kind).toBe('file')
        expect(plan.units[0].verificationInput).toMatchObject({
            _path: 'operations/check',
            oneWay: true,
            missingOnDst: true,
            differ: true,
            error: true,
            match: false,
        })
        expect(JSON.parse(plan.units[0].verificationInput._filter)).toEqual({
            IncludeRule: ['/price\\[1\\]\\*\\?.txt'],
        })
    })

    it('preserves folder filters and forces weak verification options off', () => {
        const plan = buildCopyVerifyPlan(
            copyArgs({
                options: {
                    copy: { size_only: true, ignore_checksum: true },
                    config: { transfers: 4 },
                    filter: { exclude: ['*.tmp'] },
                    remotes: {},
                },
            })
        )

        const verification = plan.units[0].verificationInput
        expect(verification._filter).toContain('ExcludeRule')
        expect(verification._config).toContain('"SizeOnly":false')
        expect(verification._config).toContain('"IgnoreChecksum":false')
    })

    it('blocks two effective sources that target the same destination object', () => {
        expect(() =>
            buildCopyVerifyPlan(
                copyArgs({
                    sources: ['/first/report.txt', '/second/report.txt'],
                })
            )
        ).toThrow('destination collision')
    })

    it('treats local Windows destination paths as case-insensitive', () => {
        expect(() =>
            buildCopyVerifyPlan(
                copyArgs({
                    sources: ['C:/first/report.txt', 'C:/second/report.txt'],
                    destination: 'C:/Destination/',
                })
            )
        ).toThrow('destination collision')
    })

    it('does not treat remote-to-local or local-to-local planning as a collision by direction', () => {
        const plan = buildCopyVerifyPlan(
            copyArgs({
                sources: ['remote:folder/'],
                destination: '/destination/',
            })
        )
        expect(plan.units[0].destinationDisplayPath).toBe(':local:destination/folder')
    })
})
