import { expect, test } from '@playwright/test'

async function openDialog(page) {
  await page.goto('/e2e/dialog-harness.html')
  await page.getByRole('button', { name: 'Open dialog', exact: true }).click()
  return page.locator('.modal-frame')
}

test('dialog contract enters and restores focus while trapping Tab', async ({ page }) => {
  const frame = await openDialog(page)
  const first = page.getByLabel('First field', { exact: true })
  const opener = page.getByRole('button', { name: 'Open dialog', exact: true })
  await expect(first).toBeFocused()

  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab')
    expect(await frame.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Shift+Tab')
    expect(await frame.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }

  await page.keyboard.press('Escape')
  await expect(frame).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test('dialog contract labels its document with caller-supplied IDs', async ({ page }) => {
  const frame = await openDialog(page)
  await expect(frame).toHaveAttribute('role', 'document')
  await expect(frame).toHaveAttribute('aria-labelledby', 'contract-title')
  await expect(frame).toHaveAttribute('aria-describedby', 'contract-description')
  await expect(page.locator('#contract-title')).toHaveText('Contract dialog')
  await expect(page.locator('#contract-description')).toContainText('local dialog contract fixture')
})

test('dialog contract generates a unique title ID when none is supplied', async ({ page }) => {
  const frame = await openDialog(page)
  await page.evaluate(() => window.dialogFixture.setCustomTitle(false))
  await expect(frame).not.toHaveAttribute('aria-labelledby', 'contract-title')
  const titleId = await frame.getAttribute('aria-labelledby')
  expect(titleId).toBeTruthy()
  await expect(page.locator('#' + titleId)).toHaveText('Contract dialog')
})

test('dialog contract routes mask, Escape, and button dismissal through one close', async ({ page }) => {
  const frame = await openDialog(page)
  const count = page.locator('#close-count')
  await page.mouse.click(5, 5)
  await expect(frame).toHaveCount(0)
  await expect(count).toHaveText('1')
  await expect(page.getByRole('button', { name: 'Open dialog', exact: true })).toBeFocused()

  await page.getByRole('button', { name: 'Open dialog', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(frame).toHaveCount(0)
  await expect(count).toHaveText('2')

  await page.getByRole('button', { name: 'Open dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Close contract', exact: true }).click()
  await expect(frame).toHaveCount(0)
  await expect(count).toHaveText('3')
})

test('dialog contract blocks every close path while busy', async ({ page }) => {
  const frame = await openDialog(page)
  await page.evaluate(() => window.dialogFixture.setBusy(true))
  const close = page.getByRole('button', { name: 'Close contract', exact: true })
  await expect(close).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(frame).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(frame).toBeVisible()
  await expect(page.locator('#close-count')).toHaveText('0')

  await page.evaluate(() => window.dialogFixture.setBusy(false))
  await expect(close).toBeEnabled()
  await close.click()
  await expect(frame).toHaveCount(0)
  await expect(page.locator('#close-count')).toHaveText('1')
})

test('dialog contract blocks mask and Escape dismissal when not dismissible', async ({ page }) => {
  const frame = await openDialog(page)
  await page.evaluate(() => window.dialogFixture.setDismissible(false))
  await page.keyboard.press('Escape')
  await expect(frame).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(frame).toBeVisible()
  await expect(page.locator('#close-count')).toHaveText('0')
  await expect(page.getByRole('button', { name: 'Close contract', exact: true })).toBeDisabled()
})
