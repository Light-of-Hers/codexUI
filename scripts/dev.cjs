const { execFileSync, spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const PNPM_VERSION = process.env.PNPM_VERSION || '9'

function isAndroidRuntime() {
  if (process.platform === 'android') return true
  if (process.env.TERMUX_VERSION) return true
  if (process.env.PREFIX?.includes('/com.termux/')) return true
  if (existsSync('/system/build.prop')) return true
  try {
    return execFileSync('uname', ['-r'], { encoding: 'utf8' }).toLowerCase().includes('android')
  } catch {
    return false
  }
}

function commandAvailable(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore', env: process.env })
  return !result.error && result.status === 0
}

function spawnPnpm(args, options = {}) {
  const spawnOptions = {
    stdio: 'inherit',
    env: process.env,
    ...options,
  }
  if (commandAvailable('pnpm')) {
    return spawnSync('pnpm', args, spawnOptions)
  }
  if (commandAvailable('corepack')) {
    return spawnSync('corepack', ['pnpm', ...args], spawnOptions)
  }
  if (commandAvailable('npm')) {
    return spawnSync('npm', ['exec', '--yes', `pnpm@${PNPM_VERSION}`, '--', ...args], spawnOptions)
  }
  throw new Error('pnpm, corepack, or npm is required')
}

function runPnpm(args, options = {}) {
  const result = spawnPnpm(args, options)
  if (result.error) {
    throw result.error
  }
  process.exit(result.status ?? 1)
}

function needsForcedInstall() {
  const modulesPath = join(process.cwd(), 'node_modules')
  if (!existsSync(modulesPath)) {
    return false
  }
  const modulesYamlPath = join(modulesPath, '.modules.yaml')
  if (!existsSync(modulesYamlPath)) {
    return true
  }
  try {
    const modulesYaml = readFileSync(modulesYamlPath, 'utf8')
    const pnpmMajor = PNPM_VERSION.split('.')[0]
    const packageManagerPattern = new RegExp(
      `(^|\\n)\\s*(?:"packageManager": "|packageManager: )pnpm@${pnpmMajor}\\.`,
    )
    return !packageManagerPattern.test(modulesYaml)
  } catch {
    return true
  }
}

function readPackageManifest() {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

function packageNodeModulesPath(packageName) {
  const parts = packageName.split('/')
  return join(process.cwd(), 'node_modules', ...parts, 'package.json')
}

function hasMissingDirectDependencies() {
  const manifest = readPackageManifest()
  const dependencyGroups = [
    manifest.dependencies,
    manifest.devDependencies,
  ]
  for (const group of dependencyGroups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue
    for (const packageName of Object.keys(group)) {
      if (!existsSync(packageNodeModulesPath(packageName))) {
        return true
      }
    }
  }
  return false
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      CODEXUI_SANDBOX_MODE: process.env.CODEXUI_SANDBOX_MODE || 'danger-full-access',
      CODEXUI_APPROVAL_POLICY: process.env.CODEXUI_APPROVAL_POLICY || 'never',
    },
    ...options,
  })
  if (result.error) {
    throw result.error
  }
  process.exit(result.status ?? 1)
}

const passthroughArgs = process.argv.slice(2)
if (passthroughArgs[0] === '--') {
  passthroughArgs.shift()
}
const viteBinPath = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
const vueTscBinPath = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'vue-tsc.cmd' : 'vue-tsc')

if (isAndroidRuntime()) {
  const cliPath = join(process.cwd(), 'dist-cli', 'index.js')
  if (!existsSync(cliPath)) {
    runPnpm(['run', 'build:cli'])
  }
  run('node', [
    cliPath,
    '--no-open',
    '--no-tunnel',
    '--no-login',
    '--no-password',
    ...passthroughArgs,
  ])
}

if (!existsSync(viteBinPath) || !existsSync(vueTscBinPath) || hasMissingDirectDependencies()) {
  const installArgs = ['install']
  if (needsForcedInstall()) {
    installArgs.push('--force')
  }
  const install = spawnPnpm(installArgs)
  if (install.error) {
    throw install.error
  }
  if (install.status !== 0) {
    process.exit(install.status ?? 1)
  }
}

run(viteBinPath, passthroughArgs)
