const { readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

const assetsDir = join(process.cwd(), 'dist', 'assets')
const budgets = [
  { pattern: /^index-[\w-]+\.js$/u, limit: 700 * 1024, label: 'entry JavaScript' },
  { pattern: /^markdownRenderer-[\w-]+\.js$/u, limit: 650 * 1024, label: 'Markdown renderer' },
]

const files = readdirSync(assetsDir)
let failed = false
for (const budget of budgets) {
  const matches = files.filter((file) => budget.pattern.test(file))
  if (matches.length === 0) {
    console.error(`Missing ${budget.label} chunk in dist/assets.`)
    failed = true
    continue
  }
  const largest = matches
    .map((file) => ({ file, bytes: statSync(join(assetsDir, file)).size }))
    .sort((left, right) => right.bytes - left.bytes)[0]
  if (!largest) continue
  console.log(`${budget.label}: ${largest.file} ${largest.bytes} bytes (limit ${budget.limit})`)
  if (largest.bytes > budget.limit) {
    console.error(`${budget.label} exceeds its budget by ${largest.bytes - budget.limit} bytes.`)
    failed = true
  }
}

if (failed) process.exitCode = 1
