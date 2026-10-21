import fs from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Fills {{PLACEHOLDERS}} in the HTML entry pages from legal/operator.json. A missing value renders a visible
 * "owner to provide" marker instead of an invented one, so an unfinished page can never pass as finished.
 */
function legalPlaceholders(): Plugin {
  const operator = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'legal/operator.json'), 'utf8')) as Record<string, string | null>
  const todo = (what: string) => `<mark class="todo">[${what}: owner to provide before launch]</mark>`
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  return {
    name: 'legal-placeholders',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const email = operator.contactEmail
        return html
          .replaceAll('{{SITE_URL}}', escape(operator.siteUrl ?? ''))
          .replaceAll('{{EFFECTIVE_DATE}}', escape(operator.effectiveDateLabel ?? operator.effectiveDate ?? ''))
          .replaceAll('{{OPERATOR_NAME}}', operator.operatorName ? escape(operator.operatorName) : todo('legal name of the operator'))
          .replaceAll('{{POSTAL_ADDRESS}}', operator.postalAddress ? escape(operator.postalAddress) : todo('postal address'))
          .replaceAll('{{CONTACT_EMAIL}}', email ? `<a href="mailto:${escape(email)}">${escape(email)}</a>` : todo('contact email'))
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), legalPlaceholders()],
  build: {
    rollupOptions: {
      // The app, plus two static pages that must be readable without signing in or running the app.
      input: {
        main: path.resolve(__dirname, 'index.html'),
        privacy: path.resolve(__dirname, 'privacy.html'),
        terms: path.resolve(__dirname, 'terms.html'),
      },
    },
  },
})
