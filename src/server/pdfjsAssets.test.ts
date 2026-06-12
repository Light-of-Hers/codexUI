import { describe, expect, it } from 'vitest'
import { getPdfjsAssetContentType, PDFJS_PACKAGE_DIR, resolvePdfjsAssetPath } from './pdfjsAssets'

describe('PDF.js local assets', () => {
  it('resolves allowed PDF.js package assets', () => {
    const assetPath = resolvePdfjsAssetPath('/web/pdf_viewer.css')

    expect(assetPath).toBeTruthy()
    expect(assetPath?.startsWith(PDFJS_PACKAGE_DIR)).toBe(true)
    expect(getPdfjsAssetContentType(assetPath ?? '')).toContain('text/css')
  })

  it('rejects traversal and unsupported top-level asset paths', () => {
    expect(resolvePdfjsAssetPath('/../package.json')).toBeNull()
    expect(resolvePdfjsAssetPath('/package.json')).toBeNull()
    expect(resolvePdfjsAssetPath('/lib/pdf.js')).toBeNull()
  })
})
