import { describe, expect, it } from 'vitest'
import { hasLanguage, loadLanguage } from './languages'

describe('the text viewer’s languages', () => {
    it('loads a language by extension, whatever its case', async () => {
        expect(await loadLanguage('main.go')).not.toBeNull()
        expect(await loadLanguage('Build.GRADLE')).not.toBeNull()
        expect(hasLanguage('notes.TOML')).toBe(true)
    })

    it('shows plain text as it is', async () => {
        for (const name of ['notes.txt', 'server.log', 'data.csv', 'run.bat', 'README', '.env']) {
            expect(hasLanguage(name)).toBe(false)
            expect(await loadLanguage(name)).toBeNull()
        }
    })

    it("doesn't read a name off the table's prototype", () => {
        expect(hasLanguage('a.constructor')).toBe(false)
        expect(hasLanguage('a.__proto__')).toBe(false)
    })

    // Each loader must name a real module and export. A typo would otherwise only show up as
    // missing colors.
    it('loads every language it lists', async () => {
        const names = [
            'a.js',
            'a.jsx',
            'a.ts',
            'a.tsx',
            'a.json',
            'a.py',
            'a.java',
            'a.c',
            'a.go',
            'a.rs',
            'a.php',
            'a.html',
            'a.xml',
            'a.css',
            'a.scss',
            'a.sass',
            'a.less',
            'a.sql',
            'a.vue',
            'a.svelte',
            'a.md',
            'a.yaml',
            'a.rb',
            'a.cs',
            'a.kt',
            'a.scala',
            'a.dart',
            'a.swift',
            'a.sh',
            'a.zsh',
            'a.ps1',
            'a.lua',
            'a.r',
            'a.pl',
            'a.erl',
            'a.clj',
            'a.hs',
            'a.ml',
            'a.fs',
            'a.vb',
            'a.s',
            'a.groovy',
            'a.proto',
            'a.diff',
            'a.toml',
            'a.ini',
            'a.env',
            'CMakeLists.txt',
            'nginx.conf',
            'extensions.conf',
        ]
        const loaded = await Promise.all(names.map((name) => loadLanguage(name)))
        expect(names.filter((_, i) => loaded[i] === null)).toEqual([])
    })

    it('picks a grammar by file name first', async () => {
        const grammar = async (name: string) =>
            ((await loadLanguage(name)) as { name?: string } | null)?.name
        expect(await grammar('CMakeLists.txt')).toBe('cmake')
        expect(await grammar('nginx.conf')).toBe('nginx')
        expect(await grammar('nginx-site.conf')).toBe('nginx')
        expect(await grammar('extensions.conf')).toBe('asterisk')
        expect(await grammar('/etc/asterisk/extensions.conf')).toBe('asterisk')
        // Other files keep their extension's grammar.
        expect(await grammar('app.conf')).toBe('properties')
        expect(await grammar('setup.cfg')).toBe('properties')
        expect(hasLanguage('notes.txt')).toBe(false)
        expect(hasLanguage('cmakelists.txt')).toBe(false)
        expect(await loadLanguage('App.svelte')).not.toBeNull()
    })
})
