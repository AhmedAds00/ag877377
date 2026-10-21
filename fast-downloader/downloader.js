'use strict';

/*
 * محرّك تحميل متسارع (segmented / multi-connection downloader)
 * -----------------------------------------------------------
 * يشرح ويطبّق نفس الفكرة اللي تعتمد عليها برامج مثل IDM:
 *   1. تقسيم الملف إلى مقاطع بايتية (segments).
 *   2. تنزيل كل مقطع بالتوازي عبر HTTP Range requests.
 *   3. الكتابة مباشرة في موضع المقطع داخل ملف واحد (positional writes).
 *   4. الاستئناف بعد الانقطاع (resume) عبر ملف حالة .state.json.
 *   5. سرقة العمل (work-stealing) لمّا يخلص مقطع بدري.
 *
 * بدون أي مكتبات خارجية — فقط وحدات Node المدمجة.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// أداة مساعدة: طلب HTTP يرجّع { statusCode, headers, res }
// نستخدم http أو https حسب البروتوكول.
// ---------------------------------------------------------------------------
function request(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => resolve(res)
    );
    req.on('error', reject);
    // نُنهي الطلب (ما نرسل جسم طلب)
    req.end();
  });
}

// ---------------------------------------------------------------------------
// الخطوة 1: فحص الملف — نجيب الحجم وهل الخادم يدعم Range؟
// نستخدم HEAD، ولو ما نفع نستخدم GET بنطاق صغير (bytes=0-0).
// ---------------------------------------------------------------------------
async function probe(url) {
  let res = await request(url, { method: 'HEAD' });
  // بعض الخوادم ما تدعم HEAD كويس → نجرّب GET بنطاق صغير
  const needFallback =
    res.statusCode >= 400 || !res.headers['content-length'];
  if (needFallback) {
    res.resume(); // نستهلك الجسم عشان نحرّر الاتصال
    res = await request(url, { headers: { Range: 'bytes=0-0' } });
  }

  const acceptsRanges =
    (res.headers['accept-ranges'] || '').includes('bytes') ||
    res.statusCode === 206;

  // الحجم: من content-range (لو رد 206) أو من content-length
  let size = null;
  if (res.headers['content-range']) {
    // الشكل: bytes 0-0/123456
    const m = /\/(\d+)\s*$/.exec(res.headers['content-range']);
    if (m) size = parseInt(m[1], 10);
  } else if (res.headers['content-length']) {
    size = parseInt(res.headers['content-length'], 10);
  }

  res.resume();
  return { size, acceptsRanges };
}

// ---------------------------------------------------------------------------
// الخطوة 2: نقسّم [0, size) إلى مقاطع متساوية تقريباً.
// ---------------------------------------------------------------------------
function planSegments(size, count) {
  const segments = [];
  const base = Math.floor(size / count);
  let start = 0;
  for (let i = 0; i < count; i++) {
    // آخر مقطع يأخذ الباقي كامل
    const end = i === count - 1 ? size - 1 : start + base - 1;
    segments.push({
      index: i,
      start, // أول بايت (شامل)
      end, // آخر بايت (شامل)
      downloaded: 0, // كم نزّلنا من هذا المقطع
    });
    start = end + 1;
  }
  return segments;
}

// ---------------------------------------------------------------------------
// الخطوة 3: تنزيل مقطع واحد والكتابة في موضعه داخل الملف.
// fd = file descriptor لملف الوجهة.
// onProgress(bytes) تُستدعى مع كل كتلة بايتات تصل.
// ---------------------------------------------------------------------------
function downloadSegment(url, fd, seg, onProgress) {
  return new Promise((resolve, reject) => {
    const from = seg.start + seg.downloaded; // ندعم الاستئناف
    const to = seg.end;
    if (from > to) return resolve(); // المقطع مكتمل مسبقاً

    request(url, { headers: { Range: `bytes=${from}-${to}` } })
      .then((res) => {
        if (res.statusCode !== 206 && res.statusCode !== 200) {
          res.resume();
          return reject(
            new Error(`المقطع ${seg.index}: رمز غير متوقع ${res.statusCode}`)
          );
        }
        let writePos = from;
        res.on('data', (chunk) => {
          // كتابة في الموضع المطلق داخل الملف
          fs.write(fd, chunk, 0, chunk.length, writePos, (err) => {
            if (err) {
              res.destroy();
              reject(err);
            }
          });
          writePos += chunk.length;
          seg.downloaded += chunk.length;
          onProgress(chunk.length);
        });
        res.on('end', resolve);
        res.on('error', reject);
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// إدارة حالة الاستئناف: نحفظ خطة المقاطع في ملف بجانب الوجهة.
// ---------------------------------------------------------------------------
function stateFile(dest) {
  return dest + '.state.json';
}
function loadState(dest, size) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(dest), 'utf8'));
    if (s.size === size) return s.segments; // نفس الملف → نكمل
  } catch (_) {}
  return null;
}
function saveState(dest, size, segments) {
  fs.writeFileSync(
    stateFile(dest),
    JSON.stringify({ size, segments }, null, 2)
  );
}

// ---------------------------------------------------------------------------
// المنزّل الرئيسي.
// ---------------------------------------------------------------------------
async function download(url, dest, { connections = 8, onProgress } = {}) {
  const { size, acceptsRanges } = await probe(url);

  // حالة عدم الدعم: نرجع لتحميل عادي بمقطع واحد.
  if (!acceptsRanges || !size) {
    console.log(
      'الخادم لا يدعم Range (أو الحجم مجهول) → تحميل بمقطع واحد.'
    );
    connections = 1;
  }

  // نحجز الملف بالحجم الكامل مسبقاً (sparse file) عشان الكتابة بالمواضع.
  const fd = fs.openSync(dest, fs.existsSync(dest) ? 'r+' : 'w');
  if (size) fs.ftruncateSync(fd, size);

  // استئناف إن وُجد، وإلا خطة جديدة.
  let segments = loadState(dest, size);
  if (!segments) segments = planSegments(size || 0, connections);

  let done = segments.reduce((a, s) => a + s.downloaded, 0);
  const report = (n) => {
    done += n;
    if (onProgress) onProgress(done, size);
  };

  // نحفظ الحالة دورياً للاستئناف.
  const saver = setInterval(() => saveState(dest, size, segments), 500);

  // قائمة المقاطع اللي باقية.
  const pending = segments.filter((s) => s.start + s.downloaded <= s.end);

  // عامل (worker): يسحب مقطع، ينزّله، وإذا خلّص وفيه مقاطع أبطأ "يسرق" نص أكبرها.
  async function worker() {
    while (pending.length) {
      const seg = pending.shift();
      if (!seg) break;
      await downloadSegment(url, fd, seg, report);

      // --- Work stealing: لو فيه مقطع كبير لسا شغّال، نقتطع نصفه الباقي. ---
      const victim = findBiggestRemaining(segments);
      if (victim && remaining(victim) > 1024 * 256) {
        const steal = splitSegment(victim);
        if (steal) {
          segments.push(steal);
          pending.push(steal);
        }
      }
    }
  }

  // نشغّل عدد العمال = عدد الاتصالات.
  const workers = [];
  for (let i = 0; i < Math.max(1, connections); i++) workers.push(worker());
  await Promise.all(workers);

  clearInterval(saver);
  fs.closeSync(fd);
  // اكتمل → نحذف ملف الحالة.
  try {
    fs.unlinkSync(stateFile(dest));
  } catch (_) {}
  return { size, connections };
}

// بايتات باقية في مقطع
function remaining(seg) {
  return seg.end - (seg.start + seg.downloaded) + 1;
}
function findBiggestRemaining(segments) {
  let best = null;
  for (const s of segments) {
    if (remaining(s) > 0 && (!best || remaining(s) > remaining(best))) best = s;
  }
  return best;
}
// نقتطع النصف الثاني غير المُنزّل من مقطع لمقطع جديد (سرقة عمل).
function splitSegment(seg) {
  const curEnd = seg.end;
  const left = seg.start + seg.downloaded;
  const mid = left + Math.floor((curEnd - left) / 2);
  if (mid <= left || mid >= curEnd) return null;
  seg.end = mid; // المقطع الأصلي يقصّر
  return {
    index: Date.now() % 100000,
    start: mid + 1,
    end: curEnd,
    downloaded: 0,
  };
}

module.exports = { download, probe, planSegments };

// ---------------------------------------------------------------------------
// تشغيل من سطر الأوامر: node downloader.js <url> <dest> [connections]
// ---------------------------------------------------------------------------
if (require.main === module) {
  const [, , url, dest, conn] = process.argv;
  if (!url || !dest) {
    console.error('الاستخدام: node downloader.js <url> <dest> [connections]');
    process.exit(1);
  }
  const start = Date.now();
  let lastLine = 0;
  download(url, path.resolve(dest), {
    connections: conn ? parseInt(conn, 10) : 8,
    onProgress: (done, size) => {
      const now = Date.now();
      if (now - lastLine < 200) return; // لا نطبع كثير
      lastLine = now;
      const pct = size ? ((done / size) * 100).toFixed(1) : '?';
      const speed = done / 1024 / ((now - start) / 1000);
      process.stdout.write(
        `\r${pct}%  ${(done / 1048576).toFixed(2)} MiB  ${speed.toFixed(0)} KiB/s   `
      );
    },
  })
    .then(({ size, connections }) => {
      const secs = (Date.now() - start) / 1000;
      console.log(
        `\nتم. ${(size / 1048576).toFixed(2)} MiB عبر ${connections} اتصال في ${secs.toFixed(2)} ثانية.`
      );
    })
    .catch((e) => {
      console.error('\nخطأ:', e.message);
      process.exit(1);
    });
}
