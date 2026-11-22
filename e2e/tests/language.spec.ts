import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { cells, nav, prompt, sendButton } from '../support/wall.ts';

/** A message key that reached the screen instead of its text, such as `app.nav.wall`. */
const RAW_KEY = /\b(?:app|wall)\.[a-z][A-Za-z]*\.[A-Za-z_.]+/;

async function expectNoRawKeys(page: Page): Promise<void> {
  const text = await page.locator('body').innerText();
  expect(RAW_KEY.exec(text)?.[0], 'an untranslated message key on screen').toBeUndefined();
  const attributes = await page
    .locator('[aria-label], [title], [placeholder]')
    .evaluateAll((elements) =>
      elements.flatMap((element) =>
        ['aria-label', 'title', 'placeholder'].map((name) => element.getAttribute(name) ?? ''),
      ),
    );
  expect(attributes.find((value) => RAW_KEY.test(value))).toBeUndefined();
}

test.describe('language', () => {
  test('the interface switches between English and Traditional Chinese', async ({
    wallPage: page,
    server,
    browser,
    guard,
  }) => {
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await nav(page, 'Settings').click();
    await page
      .getByRole('region', { name: 'Language' })
      .getByLabel('Language')
      .selectOption('zh-TW');

    // At once, everywhere, without a reload.
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('設定');
    await expect(page.getByRole('navigation').getByRole('link')).toHaveText([
      '回答牆',
      '歷史紀錄',
      '供應商',
      '設定',
    ]);
    await expect(page.getByRole('region', { name: '裝置' })).toBeVisible();
    await expectNoRawKeys(page);
    await expect
      .poll(async () => {
        const settings = await server.api<{ settings: { language: string } }>(
          'GET',
          '/api/settings',
        );
        return settings.json.settings.language;
      })
      .toBe('zh-TW');

    // Every page speaks it.
    await nav(page, '回答牆').click();
    await expect(prompt(page)).toHaveAttribute('placeholder', '一次問所有格子…');
    await expect(sendButton(page)).toHaveText('送出給 3 格');
    await expect(page.getByRole('button', { name: '新增格子' })).toBeVisible();
    await expect(cells(page).first().locator('.wall-cell-status')).toHaveText('尚無回答');
    await expect(page.locator('#wall-composer-hint')).toHaveText('請輸入提問內容再送出。');
    await expectNoRawKeys(page);

    await prompt(page).fill('你好');
    await sendButton(page).click();
    await expect(cells(page).and(page.locator('[data-phase="done"]'))).toHaveCount(3);
    await expect(cells(page).first().locator('.wall-cell-status')).toHaveText('完成');
    await expectNoRawKeys(page);

    await nav(page, '歷史紀錄').click();
    await expect(page.getByRole('heading', { name: '歷史紀錄' })).toBeVisible();
    await expect(page.locator('.wall-history-item')).toHaveCount(1);
    await expectNoRawKeys(page);

    await nav(page, '供應商').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('供應商');
    await expect(page.getByRole('button', { name: '全部重新檢查' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Claude', exact: true })).toContainText('已安裝');
    await expectNoRawKeys(page);

    // It survives a reload, and it is the language of the other devices too.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('供應商');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');

    const second = await browser.newContext({ baseURL: server.base, locale: 'en-US' });
    await guard.watch(second);
    const paired = await second.request.post('/api/auth/pair', {
      headers: { origin: server.base },
      data: { code: await server.mintPairingCode(), deviceName: 'English browser' },
    });
    expect(paired.status()).toBe(200);
    const other = await second.newPage();
    await other.goto('/');
    await expect(sendButton(other)).toHaveText('送出給 3 格');
    await second.close();

    // And back to English.
    await nav(page, '設定').click();
    await page.getByRole('region', { name: '語言' }).getByLabel('語言').selectOption('en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('navigation').getByRole('link')).toHaveText([
      'Wall',
      'History',
      'Providers',
      'Settings',
    ]);
    for (const name of ['Wall', 'History', 'Providers', 'Settings']) {
      await nav(page, name).click();
      await expect(nav(page, name)).toHaveClass(/is-active/);
      await expectNoRawKeys(page);
    }
  });

  test('the sign-in page can be read before signing in', async ({ page, server }) => {
    await page.goto('/sign-in');
    await expect(page.getByText('Pair this device with the server to continue.')).toBeVisible();
    await expectNoRawKeys(page);

    await page.getByLabel('Language').selectOption('zh-TW');
    await expect(page.getByText('請先將這台裝置與伺服器配對。')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
    await expectNoRawKeys(page);

    // Errors are translated as well.
    const code = await server.firstPairingCode();
    await page
      .getByLabel('配對碼', { exact: true })
      .last()
      .fill(code === '00000000' ? '11111111' : '00000000');
    await page.getByRole('button', { name: '登入' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      '配對碼錯誤、已使用過或已過期。請建立新的配對碼再試一次。',
    );

    // The choice is remembered on this device.
    await page.reload();
    await expect(page.getByRole('button', { name: '登入' })).toBeVisible();
  });

  test.describe('in a browser set to Traditional Chinese', () => {
    test.use({ locale: 'zh-TW' });

    test('the sign-in page starts in Traditional Chinese', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/sign-in$/);
      await expect(page.getByText('請先將這台裝置與伺服器配對。')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
      await page.getByLabel('語言').selectOption('en');
      await expect(page.getByText('Pair this device with the server to continue.')).toBeVisible();
    });
  });
});
