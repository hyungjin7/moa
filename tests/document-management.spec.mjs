import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { reviewRoot } from '../scripts/review-fixtures.mjs'
import { login } from './review-session.mjs'

test('admin moves groups/projects, deletes and restores a real report in isolated UI', async ({ page }) => {
  const slug = 'management-ui-fixture'
  const files = ['moa-design', 'brand-notes'].map(s => path.join(reviewRoot, 'projects', s, slug + '.mdx'))
  const clean = () => {
    files.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f) })
    for (const project of ['moa-design', 'brand-notes']) {
      const key = crypto.createHash('sha256').update(JSON.stringify([project, slug])).digest('hex')
      fs.rmSync(path.join(reviewRoot, '.document-history', key), { recursive: true, force: true })
    }
    const bin = path.join(reviewRoot, '.document-trash')
    if (fs.existsSync(bin)) for (const id of fs.readdirSync(bin)) {
      const file = path.join(bin, id, 'meta.json')
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).doc === slug) fs.rmSync(path.join(bin, id), { recursive: true, force: true })
    }
  }
  const original = "export const title = 'Management fixture'\nexport const group = 'UI verification'\n\n# Lifecycle body survives\n"
  clean()
  fs.writeFileSync(files[0], original)
  try {
    await login(page)
    await page.goto('/p/moa-design/' + slug)
    await expect(page.getByRole('heading', { name: 'Lifecycle body survives' })).toBeVisible()
    await page.getByRole('button', { name: '이동', exact: true }).click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel('대상 그룹', { exact: true }).fill('Moved group')
    await dialog.getByRole('button', { name: '이동', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect.poll(() => fs.readFileSync(files[0], 'utf8')).toContain("'Moved group'")
    await page.getByRole('button', { name: '이동', exact: true }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('대상 프로젝트').selectOption('brand-notes')
    await dialog.getByRole('button', { name: '이동', exact: true }).click()
    await page.waitForURL('**/p/brand-notes/' + slug)
    await expect(page.getByRole('heading', { name: 'Lifecycle body survives' })).toBeVisible()
    expect(fs.existsSync(files[0])).toBe(false)
    await page.getByRole('button', { name: '삭제', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '휴지통으로 이동', exact: true }).click()
    await page.waitForURL('http://localhost:5001/')
    expect(fs.existsSync(files[1])).toBe(false)
    await page.getByRole('button', { name: '휴지통', exact: true }).click()
    dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Management fixture', { exact: true })).toBeVisible()
    await dialog.locator('div').filter({ has: page.getByText('Management fixture', { exact: true }) }).filter({ has: page.getByRole('button', { name: '복원', exact: true }) }).last().getByRole('button', { name: '복원', exact: true }).click()
    await page.waitForURL('**/p/brand-notes/' + slug)
    await expect(page.getByRole('heading', { name: 'Lifecycle body survives' })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('button', { name: '삭제', exact: true })).toBeVisible()
    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: window.innerWidth }))
    expect(widths.page).toBeLessThanOrEqual(widths.viewport + 1)
    await page.screenshot({ path: 'artifacts/document-management-mobile.png', fullPage: true })
  } finally { clean() }
})
