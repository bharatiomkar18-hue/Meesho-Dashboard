const { chromium } = require('playwright');
const XLSX_PATH = '/root/.claude/uploads/3dc5e652-6b89-5e0e-8fc4-7e88e2c9bde2/231eac1a-shipment_status_report___dbrk_1100__20260826T10_26_04.00413044Z.xlsx';
const BASE = 'http://localhost:8899';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });

  // ---- Viewer 1: loads with no shared data yet ----
  const page1 = await context.newPage();
  const errors1 = [];
  page1.on('pageerror', e => errors1.push(e.message));
  page1.on('console', m => { if (m.type()==='error') errors1.push(m.text()); });
  await page1.goto(BASE + '/');
  await page1.waitForSelector('#emptyState:not([hidden])', { timeout: 8000 });
  console.log('Viewer1: empty state shown when nothing uploaded yet — OK');

  // ---- Viewer1 uploads with WRONG password first ----
  const fileInput1 = await page1.$('#fileInput');
  await fileInput1.setInputFiles(XLSX_PATH);
  await page1.waitForSelector('#pwBackdrop:not([hidden])', { timeout: 8000 });
  console.log('Password modal appeared after file parse — OK');
  await page1.fill('#pwInput', 'wrong-password');
  await page1.click('#pwConfirmBtn');
  await page1.waitForTimeout(600);
  const pwErrText = await page1.$eval('#pwError', el => el.textContent);
  console.log('Wrong-password error shown:', JSON.stringify(pwErrText));
  const modalStillOpen = await page1.$eval('#pwBackdrop', el => el.hidden === false);
  console.log('Modal stayed open after wrong password:', modalStillOpen);

  // ---- Now correct password ----
  await page1.fill('#pwInput', 'Cops@2026!');
  await page1.click('#pwConfirmBtn');
  await page1.waitForSelector('#dashboardBody:not([hidden])', { timeout: 15000 });
  console.log('Dashboard rendered after successful shared upload — OK');
  const fileMeta = await page1.$eval('#fileMetaLbl', el => el.textContent);
  console.log('File meta label:', fileMeta);
  const kpiRows = await page1.$$eval('#kpiTable tr', trs => trs.length);
  console.log('KPI rows:', kpiRows);

  // ---- Viewer 2: fresh page load, should see the SAME shared data without uploading ----
  const page2 = await context.newPage();
  const errors2 = [];
  page2.on('pageerror', e => errors2.push(e.message));
  page2.on('console', m => { if (m.type()==='error') errors2.push(m.text()); });
  await page2.goto(BASE + '/');
  await page2.waitForSelector('#dashboardBody:not([hidden])', { timeout: 10000 });
  console.log('Viewer2 (fresh tab, no upload) sees shared dashboard immediately — OK');
  const fileMeta2 = await page2.$eval('#fileMetaLbl', el => el.textContent);
  console.log('Viewer2 file meta label:', fileMeta2);
  const kpiText2 = await page2.$eval('#kpiTable', el => el.innerText);
  console.log('Viewer2 KPI sample:\n' + kpiText2.split('\n').slice(0,3).join('\n'));

  // ---- Viewer2 clicks Refresh (nothing new, should stay same + show chip) ----
  await page2.click('#refreshBtnTop');
  await page2.waitForTimeout(600);
  const chipText = await page2.$eval('#syncChip', el => el.textContent).catch(()=>null);
  console.log('Sync chip after refresh (viewer2):', chipText);

  // ---- Drill-down + copy-for-email spot check on viewer2 (shared data) ----
  const flaggedRow = await page2.$('#m1-table tr.rowdrillable, #m5-table tr.rowdrillable');
  if (flaggedRow){
    await flaggedRow.dblclick();
    await page2.waitForTimeout(300);
    console.log('Drill-down opened on shared data:', !!(await page2.$('.drilldown-panel')));
    await page2.click('.drilldown-close');
  }
  const ovBtn = await page2.$('.btn-emailcopy[data-copy-section="overview"]');
  await ovBtn.click();
  await page2.waitForTimeout(600);
  const clip = await page2.evaluate(async () => navigator.clipboard.readText());
  console.log('Copy-for-email on shared data works, has Pickup Efficiency:', clip.includes('Pickup Efficiency'));

  console.log('\n--- console/page errors viewer1 ---', errors1);
  console.log('--- console/page errors viewer2 ---', errors2);

  await browser.close();
  console.log('\n--- DONE ---');
})().catch(e => { console.error('E2E FAILURE:', e); process.exit(1); });
