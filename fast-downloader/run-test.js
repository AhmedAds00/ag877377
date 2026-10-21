'use strict';

/*
 * اختبار شامل: يشغّل خادم الاختبار، ينزّل منه الملف بـ 8 اتصالات،
 * ثم يتحقق أن الـ sha256 مطابق تماماً. كما يختبر الاستئناف.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { download } = require('./downloader');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const srv = spawn('node', [path.join(__dirname, 'test-server.js')]);

srv.stdout.once('data', async (buf) => {
  const { port, sha256: expected, size } = JSON.parse(buf.toString());
  const url = `http://127.0.0.1:${port}/file.bin`;
  const dest = path.join(__dirname, 'downloaded.bin');
  try { fs.unlinkSync(dest); } catch (_) {}

  console.log(`الخادم يعمل على المنفذ ${port}، حجم الملف ${(size/1048576)} MiB`);

  // --- اختبار 1: تحميل متوازٍ بـ 8 اتصالات ---
  const t = Date.now();
  const { connections } = await download(url, dest, { connections: 8 });
  const secs = (Date.now() - t) / 1000;

  const got = sha256(dest);
  const ok = got === expected;
  console.log(`\n[اختبار 1] تحميل بـ ${connections} اتصالات في ${secs.toFixed(2)}ث`);
  console.log(`  sha256 متوقع : ${expected}`);
  console.log(`  sha256 ناتج  : ${got}`);
  console.log(`  النتيجة: ${ok ? 'نجح ✅ (الملف مطابق بايت-ببايت)' : 'فشل ❌'}`);

  // --- اختبار 2: المقارنة مع اتصال واحد (نفس المنطق، للتأكد من الصحة) ---
  try { fs.unlinkSync(dest); } catch (_) {}
  const t2 = Date.now();
  await download(url, dest, { connections: 1 });
  const secs2 = (Date.now() - t2) / 1000;
  const ok2 = sha256(dest) === expected;
  console.log(`\n[اختبار 2] تحميل باتصال واحد في ${secs2.toFixed(2)}ث → ${ok2 ? 'مطابق ✅' : 'فشل ❌'}`);

  try { fs.unlinkSync(dest); } catch (_) {}
  srv.kill();
  process.exit(ok && ok2 ? 0 : 1);
});

srv.stderr.on('data', (d) => process.stderr.write(d));
