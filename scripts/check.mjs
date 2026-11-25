/**
 * Repository checks for the published bundle. Runs without dependencies:
 *   node scripts/check.mjs
 *
 * Verifies the manifest, the client module id (it must equal the package name),
 * the loader patch, exported assets, locale metadata, and that every file the
 * package promises to ship actually exists.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0

const ok = (message) => console.log(`ok   ${message}`)
const fail = (message) => {
  failures += 1
  console.error(`FAIL ${message}`)
}
const exists = async (relative) => {
  try {
    await stat(join(root, relative))
    return true
  } catch {
    return false
  }
}
const read = (relative) => readFile(join(root, relative), 'utf8')

const pkg = JSON.parse(await read('package.json'))

// 1. Publishing identity.
if (/^@local\//.test(pkg.name)) fail(`package name is still local: ${pkg.name}`)
else ok(`package name ${pkg.name}`)
if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg.version)) fail('version is not semver')
else ok(`version ${pkg.version}`)
if (pkg.license !== 'MIT') fail(`license is ${String(pkg.license)}, expected MIT`)
else if (!(await exists('LICENSE'))) fail('LICENSE file is missing')
else if (!(await read('LICENSE')).includes('MIT License')) fail('LICENSE does not look like MIT')
else ok('MIT license and LICENSE file')

// 2. Client module id must equal the package name.
const client = await read('client.js')
const clientId = client.match(/\bid:\s*'([^']+)'/)?.[1] ?? ''
if (clientId !== pkg.name) fail(`client.js module id "${clientId}" != package name "${pkg.name}"`)
else ok(`client module id ${clientId}`)

// 3. Loader patch inserts this package.
const patchPath = pkg.dsh?.bundle?.patch
if (typeof patchPath !== 'string' || !(await exists(patchPath))) fail('dsh.bundle.patch is missing or does not exist')
else if (!(await read(patchPath)).includes(pkg.name)) fail(`${patchPath} does not name ${pkg.name}`)
else ok(`loader patch ${patchPath}`)

// 4. Runtime exports resolve.
for (const [key, target] of Object.entries(pkg.exports ?? {})) {
  if (target.includes('*')) continue
  if (!(await exists(target))) fail(`exports["${key}"] -> ${target} is missing`)
  else ok(`export ${key} -> ${target}`)
}

// 5. Every promised file ships.
const expand = async (pattern) => {
  if (!pattern.includes('*')) return [pattern]
  const [dirPart] = pattern.split('*')
  const directory = dirPart.replace(/\/$/, '') || '.'
  const suffix = pattern.slice(pattern.indexOf('*') + 1)
  const entries = await readdir(join(root, directory))
  return entries.filter((name) => name.endsWith(suffix.replace(/^\*?/, ''))).map((name) => `${directory}/${name}`)
}
for (const entry of pkg.files ?? []) {
  for (const relative of await expand(entry)) {
    if (!(await exists(relative))) fail(`files entry ${entry} resolves to missing ${relative}`)
  }
}
ok(`files list resolves (${(pkg.files ?? []).length} entries)`)

// 6. Locale metadata is present and the detail document exists.
const localeFiles = (await readdir(join(root, 'locale'))).filter((name) => name.endsWith('.json'))
if (localeFiles.length === 0) fail('no locale files')
for (const name of localeFiles) {
  const locale = JSON.parse(await read(`locale/${name}`))
  const meta = locale.meta ?? {}
  if (typeof meta.title !== 'string' || meta.title === '') fail(`locale/${name} has no meta.title`)
  else if (typeof meta.description !== 'string' || meta.description === '') fail(`locale/${name} has no meta.description`)
  else ok(`locale/${name} metadata`)
  if (typeof meta.detail === 'string') {
    if (!(await exists(meta.detail))) fail(`locale/${name} meta.detail -> ${meta.detail} is missing`)
  }
}

// 7. Icon is a real image within the size limit.
if (!(await exists('icon.svg'))) fail('icon.svg is missing')
else {
  const icon = await stat(join(root, 'icon.svg'))
  const head = (await read('icon.svg')).trimStart()
  if (icon.size > 256 * 1024) fail(`icon.svg is ${icon.size} bytes, over 256 KiB`)
  else if (!head.startsWith('<svg') && !head.startsWith('<?xml')) fail('icon.svg does not look like SVG')
  else ok(`icon.svg (${icon.size} bytes)`)
}

// 8. No local-only package references remain.
for (const relative of ['index.js', 'client.js', 'session-runtime.js', 'cordis.patch.yml']) {
  if ((await read(relative)).includes('@local/')) fail(`${relative} still references @local/`)
}
ok('no @local/ references')

// 9. Relative imports resolve.
for (const relative of ['index.js', 'client.js', 'session-runtime.js']) {
  const source = await read(relative)
  for (const match of source.matchAll(/from\s+'(\.\/[^']+)'/g)) {
    if (!(await exists(match[1]))) fail(`${relative} imports missing ${match[1]}`)
  }
}
ok('relative imports resolve')

// 10. Repository files a reader expects.
for (const relative of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', '.gitignore']) {
  if (!(await exists(relative))) fail(`${relative} is missing`)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
