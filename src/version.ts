import { readFileSync } from 'node:fs'

interface Pkg {
    name: string
    version: string
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Pkg

export const name = pkg.name
export const version = pkg.version
