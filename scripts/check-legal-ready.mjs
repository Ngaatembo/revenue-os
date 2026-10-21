#!/usr/bin/env node
// Lists what is still unresolved on /privacy and /terms before they can be submitted to Google. Exit 1 while anything is open.
// It reads legal/operator.json and the source HTML only: it changes nothing and never invents a value.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const operator = JSON.parse(fs.readFileSync(path.join(root, 'legal/operator.json'), 'utf8'))
const open = []
for (const [key, label] of [['operatorName', 'Legal name of the operator'], ['contactEmail', 'Contact email for privacy and security requests'], ['postalAddress', 'Postal address']]) {
  if (!operator[key]) open.push(`legal/operator.json → ${key}: ${label}`)
}
for (const page of ['privacy.html', 'terms.html']) {
  const html = fs.readFileSync(path.join(root, page), 'utf8')
  for (const match of html.matchAll(/<mark class="todo">\[([^\]]+)\]<\/mark>/g)) open.push(`${page}: ${match[1]}`)
}
if (!/^https:\/\/[^/]+$/.test(operator.siteUrl ?? '') || /workers\.dev/.test(operator.siteUrl)) {
  open.push(`legal/operator.json → siteUrl is ${operator.siteUrl}: Google verifies a domain you own; a workers.dev address cannot be verified. Set the final domain.`)
}
if (open.length === 0) { console.log('Legal pages: every operator detail is provided.'); process.exit(0) }
console.log(`Legal pages are NOT ready to submit. ${open.length} item(s) open:`)
for (const item of open) console.log(' - ' + item)
process.exit(1)
