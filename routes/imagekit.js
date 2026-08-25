// routes/imagekit.js
//
// ImageKit's browser-upload flow needs a "permission slip" for every
// upload — a signature proving the request really came from this backend.
// Generating that signature requires the ImageKit PRIVATE key, which must
// never be sent to the browser. So instead, the dashboard asks THIS route
// for a permission slip first, then uploads the file directly to ImageKit
// using that slip. The private key stays on the server the whole time.
//
// This route is AUTHENTICATED (requireAuth) — only a logged-in merchant
// can request a permission slip. Buyers on the public storefront never
// upload anything, so they never need this.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

router.get('/auth', (req, res) => {
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!privateKey) {
    return res.status(500).json({ error: 'Image uploads are not configured on the server yet.' });
  }

  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 60 * 10; // valid for 10 minutes
  const signature = crypto
    .createHmac('sha1', privateKey)
    .update(token + expire)
    .digest('hex');

  res.json({ token, expire, signature, publicKey: process.env.IMAGEKIT_PUBLIC_KEY });
});

module.exports = router;
