'use strict';

/*
 * خادم اختبار محلي يدعم HTTP Range requests.
 * يخدم ملفاً تجريبياً (نولّده في الذاكرة) عشان نثبت أن المنزّل يشتغل فعلاً
 * دون لمس أي موقع خارجي.
 */

const http = require('http');
const crypto = require('crypto');

// نولّد "ملف" 20 MiB بمحتوى يمكن التحقق منه بالـ hash.
const SIZE = 20 * 1024 * 1024;
const FILE = crypto.randomBytes(SIZE);
const FILE_SHA = crypto.createHash('sha256').update(FILE).digest('hex');

const server = http.createServer((req, res) => {
  const range = req.headers['range'];

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Length': SIZE,
      'Accept-Ranges': 'bytes',
    });
    return res.end();
  }

  if (range) {
    // الشكل: bytes=start-end
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : SIZE - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${SIZE}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    return res.end(FILE.subarray(start, end + 1));
  }

  // بدون Range → الملف كامل
  res.writeHead(200, {
    'Content-Length': SIZE,
    'Accept-Ranges': 'bytes',
  });
  res.end(FILE);
});

server.listen(0, () => {
  const port = server.address().port;
  // نطبع المعلومات اللي يحتاجها سكربت الاختبار.
  console.log(JSON.stringify({ port, sha256: FILE_SHA, size: SIZE }));
});
