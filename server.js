const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Backend API URL ─────────────────────────────────────────────────────────
const API_URL = process.env.API_URL || 'https://kiroboost-api-newshare.onrender.com';

// ─── Facebook Headers ────────────────────────────────────────────────────────

// General browser headers (used for content_management token extraction)
const FB_HEADERS = {
    'user-agent'               : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36',
    'sec-ch-ua'                : '"Google Chrome";v="107", "Chromium";v="107", "Not=A?Brand";v="24"',
    'sec-ch-ua-mobile'         : '?0',
    'sec-ch-ua-platform'       : '"Windows"',
    'sec-fetch-dest'           : 'document',
    'sec-fetch-mode'           : 'navigate',
    'sec-fetch-site'           : 'none',
    'sec-fetch-user'           : '?1',
    'upgrade-insecure-requests': '1',
    'accept'                   : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language'          : 'en-US,en;q=0.9',
    'cache-control'            : 'max-age=0'
};

// Share / b-graph API headers
const SHARE_HEADERS = {
    'user-agent'        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36',
    'sec-ch-ua'         : '"Google Chrome";v="107", "Chromium";v="107", "Not=A?Brand";v="24"',
    'sec-ch-ua-mobile'  : '?0',
    'sec-ch-ua-platform': '"Windows"',
    'accept'            : '*/*',
    'accept-language'   : 'en-US,en;q=0.9',
    'accept-encoding'   : 'gzip, deflate',
    'host'              : 'b-graph.facebook.com'
};

// Business Facebook mobile headers (business_locations token extraction)
const BUSINESS_HEADERS = {
    'user-agent'               : 'Mozilla/5.0 (Linux; Android 8.1.0; MI 8 Build/OPM1.171019.011) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.86 Mobile Safari/537.36',
    'referer'                  : 'https://www.facebook.com/',
    'host'                     : 'business.facebook.com',
    'origin'                   : 'https://business.facebook.com',
    'upgrade-insecure-requests': '1',
    'accept-language'          : 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'cache-control'            : 'max-age=0',
    'accept'                   : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'content-type'             : 'text/html; charset=utf-8'
};

// ─── Middleware ───────────────────────────────────────────────────────────────

// 50 mb limit matches server.js — needed for GIF banner base64 uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Active Sessions Store ────────────────────────────────────────────────────

const activeSessions = new Map();

// Auto-clean completed/stopped sessions older than 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of activeSessions.entries()) {
        if (['completed', 'stopped'].includes(s.status) && now - s.createdAt > 30 * 60 * 1000) {
            activeSessions.delete(id);
        }
    }
}, 30 * 60 * 1000);

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Speed to delay in ms per share:
 *   instant  =    0 ms  (no delay, DEFAULT)
 *   fast     = 2000 ms
 *   slow     = 3000 ms
 */
function getShareDelay(speed) {
    switch ((speed || 'instant').toLowerCase()) {
        case 'slow':    return 3000;
        case 'fast':    return 2000;
        case 'instant':
        default:        return 0;
    }
}

/** Extract numeric post ID from any Facebook URL format. */
function extractPostId(link) {
    link = link.trim();
    if (/^\d+$/.test(link)) return link;

    link = link.replace(/^https?:\/\//i, '').replace(/^(www\.|m\.)/i, '');

    const patterns = [
        /facebook\.com\/.*?\/posts\/(\d+)/,
        /facebook\.com\/.*?\/photos\/.*?\/(\d+)/,
        /facebook\.com\/permalink\.php\?story_fbid=(\d+)/,
        /facebook\.com\/story\.php\?story_fbid=(\d+)/,
        /facebook\.com\/photo\.php\?fbid=(\d+)/,
        /\/(\d+)\/?$/
    ];

    for (const p of patterns) {
        const m = link.match(p);
        if (m) return m[1];
    }
    return link;
}

/** Get query string from req.originalUrl */
function qs(req) {
    const idx = req.originalUrl.indexOf('?');
    return idx !== -1 ? req.originalUrl.slice(idx) : '';
}

// ─── Proxy Helper ─────────────────────────────────────────────────────────────

/**
 * Forward a request to the KiroBoost API backend (server.js).
 * targetPath should be the full /api/... path to forward to.
 */
async function proxyToAPI(req, res, targetPath) {
    try {
        const url = `${API_URL}${targetPath}`;

        const config = {
            method  : req.method,
            url,
            headers : {
                'Content-Type': 'application/json',
                ...(req.headers.authorization && { Authorization: req.headers.authorization })
            },
            timeout         : 30000,
            maxContentLength: 50 * 1024 * 1024,
            maxBodyLength   : 50 * 1024 * 1024
        };

        if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
            config.data = req.body;
        }

        const response = await axios(config);
        return res.status(response.status).json(response.data);
    } catch (error) {
        const status = error.response?.status || 500;
        const data   = error.response?.data   || { success: false, message: error.message };
        return res.status(status).json(data);
    }
}

// ─── Token Extraction ─────────────────────────────────────────────────────────

async function getTokenFromContentManagement(cookie) {
    try {
        const r = await axios.get('https://business.facebook.com/content_management', {
            headers     : { ...FB_HEADERS, cookie },
            timeout     : 15000,
            maxRedirects: 5
        });
        const m = r.data.match(/EAAG(.*?)"/);
        return m ? 'EAAG' + m[1] : null;
    } catch { return null; }
}

async function getTokenFromBusinessLocations(cookie) {
    try {
        const r = await axios.get('https://business.facebook.com/business_locations', {
            headers     : { ...BUSINESS_HEADERS, cookie },
            timeout     : 15000,
            maxRedirects: 5
        });
        const m = r.data.match(/(EAAG\w+)/);
        return m ? m[1] : null;
    } catch { return null; }
}

async function extractToken(cookie, method) {
    let token = null;
    if (method === 'smm' || method === 'content_management') {
        token = await getTokenFromContentManagement(cookie);
    }
    if (!token) token = await getTokenFromBusinessLocations(cookie);
    return token;
}

// ─── Post ID Extraction ───────────────────────────────────────────────────────

async function getPostIdFromApi(link) {
    try {
        const r = await axios.post(
            'https://id.traodoisub.com/api.php',
            `link=${encodeURIComponent(link)}`,
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );
        return r.data?.id || null;
    } catch { return null; }
}

// ─── Share Functions ──────────────────────────────────────────────────────────

/** Standard share via b-graph — postId must be numeric */
async function sharePost(cookie, token, postId) {
    try {
        const url = `https://b-graph.facebook.com/me/feed?link=https://mbasic.facebook.com/${postId}&published=0&access_token=${token}`;
        const r   = await axios.post(url, null, { headers: { ...SHARE_HEADERS, cookie }, timeout: 12000 });
        if (r.data?.id) return { success: true, id: r.data.id };
        return { success: false, error: r.data?.error?.message || 'Unknown error' };
    } catch (e) {
        return { success: false, error: e.response?.data?.error?.message || e.message };
    }
}

/** SMM share via b-graph — postLink is the full Facebook URL */
async function smmShare(cookie, token, postLink) {
    try {
        const url = `https://b-graph.facebook.com/me/feed?link=${encodeURIComponent(postLink)}&published=0&access_token=${token}`;
        const r   = await axios.post(url, null, { headers: { ...SHARE_HEADERS, cookie }, timeout: 12000 });
        if (r.data?.id) return { success: true, id: r.data.id };
        return { success: false, error: r.data?.error?.message || 'Unknown error' };
    } catch (e) {
        return { success: false, error: e.response?.data?.error?.message || e.message };
    }
}

// =============================================================================
//  API PROXY ROUTES  (all server.js endpoints — explicitly wired)
// =============================================================================

// ── AUTH ──────────────────────────────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', (req, res) =>
    proxyToAPI(req, res, '/api/auth/register'));

// POST /api/auth/login
app.post('/api/auth/login', (req, res) =>
    proxyToAPI(req, res, '/api/auth/login'));

// ── USER — SHARE TRACKING ─────────────────────────────────────────────────────

// POST /api/share/start
// body:     { postLink?, quantity?, accountCount?, speed?, referenceNote? }
// response: { success, orderId }  ← orderId links the session to a BoosterOrder
app.post('/api/share/start', (req, res) =>
    proxyToAPI(req, res, '/api/share/start'));

// POST /api/share/complete
// body: { totalShares, orderId, stopped?, failCount? }
//   orderId  — from /api/share/start response; links shares to the BoosterOrder
//   stopped  — true if user manually stopped the session (marks order partial/cancelled)
//   failCount — number of failed share attempts
app.post('/api/share/complete', (req, res) =>
    proxyToAPI(req, res, '/api/share/complete'));

// ── USER — STATS ──────────────────────────────────────────────────────────────

// GET /api/user/stats
app.get('/api/user/stats', (req, res) =>
    proxyToAPI(req, res, `/api/user/stats${qs(req)}`));

// ── USER — PROFILE IMAGE ──────────────────────────────────────────────────────

// POST /api/user/profile/image  body: { imageData } (base64, supports GIF)
app.post('/api/user/profile/image', (req, res) =>
    proxyToAPI(req, res, '/api/user/profile/image'));

// DELETE /api/user/profile/image
app.delete('/api/user/profile/image', (req, res) =>
    proxyToAPI(req, res, '/api/user/profile/image'));

// ── USER — PROFILE BANNER ─────────────────────────────────────────────────────

// POST /api/user/profile/banner  body: { imageData } (base64, supports GIF)
app.post('/api/user/profile/banner', (req, res) =>
    proxyToAPI(req, res, '/api/user/profile/banner'));

// DELETE /api/user/profile/banner
app.delete('/api/user/profile/banner', (req, res) =>
    proxyToAPI(req, res, '/api/user/profile/banner'));

// ── USER — PROFILE DETAILS ────────────────────────────────────────────────────

// PUT /api/user/profile  body: { bio, status, avatarBorder, sticker, bannerColor, accentColor }
app.put('/api/user/profile', (req, res) =>
    proxyToAPI(req, res, '/api/user/profile'));

// GET /api/user/profile/:username  (public, no auth needed)
app.get('/api/user/profile/:username', (req, res) =>
    proxyToAPI(req, res, `/api/user/profile/${req.params.username}`));

// ── USER — COOKIES ────────────────────────────────────────────────────────────

// POST /api/user/cookies  body: { cookie }  — validates & saves cookie
app.post('/api/user/cookies', (req, res) =>
    proxyToAPI(req, res, '/api/user/cookies'));

// GET /api/user/cookies
app.get('/api/user/cookies', (req, res) =>
    proxyToAPI(req, res, '/api/user/cookies'));

// DELETE /api/user/cookies/:cookieId
app.delete('/api/user/cookies/:cookieId', (req, res) =>
    proxyToAPI(req, res, `/api/user/cookies/${req.params.cookieId}`));

// POST /api/user/cookies/delete-multiple  body: { cookieIds: [] }
app.post('/api/user/cookies/delete-multiple', (req, res) =>
    proxyToAPI(req, res, '/api/user/cookies/delete-multiple'));

// ── USER — ORDER HISTORY (Transactions page) ──────────────────────────────────

// GET /api/user/orders/history  query: limit, status
// response includes: summary { total, completed, pending, processing }, orders[]
// each order: orderId, customerName, postLink, quantity, amount, status,
//             currentCount, remainingCount, referenceNote, date, time, createdAt, completedAt
app.get('/api/user/orders/history', (req, res) =>
    proxyToAPI(req, res, `/api/user/orders/history${qs(req)}`));

// GET /api/user/orders/search  query: reference (searches referenceNote AND orderId)
app.get('/api/user/orders/search', (req, res) =>
    proxyToAPI(req, res, `/api/user/orders/search${qs(req)}`));

// ── USER — INBOX ──────────────────────────────────────────────────────────────

// GET /api/user/inbox  query: filter (all|unread|announcements|promos), limit
app.get('/api/user/inbox', (req, res) =>
    proxyToAPI(req, res, `/api/user/inbox${qs(req)}`));

// FIX: read-all MUST be declared before /:messageId to prevent Express
//      from treating "read-all" as a messageId param value.
// PUT /api/user/inbox/read-all
app.put('/api/user/inbox/read-all', (req, res) =>
    proxyToAPI(req, res, '/api/user/inbox/read-all'));

// GET /api/user/inbox/:messageId  — also auto-marks as read
app.get('/api/user/inbox/:messageId', (req, res) =>
    proxyToAPI(req, res, `/api/user/inbox/${req.params.messageId}`));

// PUT /api/user/inbox/:messageId/read
app.put('/api/user/inbox/:messageId/read', (req, res) =>
    proxyToAPI(req, res, `/api/user/inbox/${req.params.messageId}/read`));

// DELETE /api/user/inbox/:messageId
app.delete('/api/user/inbox/:messageId', (req, res) =>
    proxyToAPI(req, res, `/api/user/inbox/${req.params.messageId}`));

// ── ADMIN — ORDERS ────────────────────────────────────────────────────────────

// POST /api/admin/orders
// body: { customOrderId?, customerName, postLink, quantity, amount?, notes?, referenceNote?, speed?, priority? }
app.post('/api/admin/orders', (req, res) =>
    proxyToAPI(req, res, '/api/admin/orders'));

// GET /api/admin/orders  query: status, limit, customerName, sortBy, sortOrder
app.get('/api/admin/orders', (req, res) =>
    proxyToAPI(req, res, `/api/admin/orders${qs(req)}`));

// FIX: stats/summary and bulk/status MUST be declared before /:orderId
//      to prevent Express matching "stats" or "bulk" as an orderId param.

// GET /api/admin/orders/stats/summary  (admin only)
app.get('/api/admin/orders/stats/summary', (req, res) =>
    proxyToAPI(req, res, '/api/admin/orders/stats/summary'));

// PUT /api/admin/orders/bulk/status  body: { orderIds: [], status }  (admin only)
app.put('/api/admin/orders/bulk/status', (req, res) =>
    proxyToAPI(req, res, '/api/admin/orders/bulk/status'));

// GET /api/admin/orders/:orderId
app.get('/api/admin/orders/:orderId', (req, res) =>
    proxyToAPI(req, res, `/api/admin/orders/${req.params.orderId}`));

// PUT /api/admin/orders/:orderId  body: { status?, currentCount?, notes?, referenceNote?, startCount? }
app.put('/api/admin/orders/:orderId', (req, res) =>
    proxyToAPI(req, res, `/api/admin/orders/${req.params.orderId}`));

// DELETE /api/admin/orders/:orderId  (admin only)
app.delete('/api/admin/orders/:orderId', (req, res) =>
    proxyToAPI(req, res, `/api/admin/orders/${req.params.orderId}`));

// ── ADMIN — INBOX ─────────────────────────────────────────────────────────────

// POST /api/admin/inbox/broadcast
// body: { title, content, imageUrl?, type?, targetUsers: 'all'|'active'|'inactive'|[...usernames] }
app.post('/api/admin/inbox/broadcast', (req, res) =>
    proxyToAPI(req, res, '/api/admin/inbox/broadcast'));

// POST /api/admin/inbox/send  body: { username, title, content, imageUrl?, type? }
app.post('/api/admin/inbox/send', (req, res) =>
    proxyToAPI(req, res, '/api/admin/inbox/send'));

// GET /api/admin/inbox/stats
app.get('/api/admin/inbox/stats', (req, res) =>
    proxyToAPI(req, res, '/api/admin/inbox/stats'));

// ── ADMIN — USER MANAGEMENT ───────────────────────────────────────────────────

// GET /api/admin/users
app.get('/api/admin/users', (req, res) =>
    proxyToAPI(req, res, '/api/admin/users'));

// FIX: DELETE /api/admin/users (delete ALL) MUST be before /:username
//      to prevent Express treating the empty segment as a username param.
app.delete('/api/admin/users', (req, res) =>
    proxyToAPI(req, res, '/api/admin/users'));

// PUT /api/admin/users/:username/activate
app.put('/api/admin/users/:username/activate', (req, res) =>
    proxyToAPI(req, res, `/api/admin/users/${req.params.username}/activate`));

// PUT /api/admin/users/:username/deactivate
app.put('/api/admin/users/:username/deactivate', (req, res) =>
    proxyToAPI(req, res, `/api/admin/users/${req.params.username}/deactivate`));

// DELETE /api/admin/users/:username
app.delete('/api/admin/users/:username', (req, res) =>
    proxyToAPI(req, res, `/api/admin/users/${req.params.username}`));

// ── ADMIN — DASHBOARD ─────────────────────────────────────────────────────────

// GET /api/admin/dashboard
app.get('/api/admin/dashboard', (req, res) =>
    proxyToAPI(req, res, '/api/admin/dashboard'));

// ── FALLBACK — future-proof for any new server.js endpoints ───────────────────
app.use('/api', (req, res) => proxyToAPI(req, res, req.originalUrl));

// =============================================================================
//  SHARING ENGINE ROUTES  (handled locally — not proxied to server.js)
// =============================================================================

// POST /share/extract-token
// Extract an EAAG token from a Facebook cookie.
// body: { cookie, method? ('smm'|'content_management'|'business_locations') }
app.post('/share/extract-token', async (req, res) => {
    const { cookie, method } = req.body;
    if (!cookie) return res.status(400).json({ success: false, message: 'cookie is required' });

    const token = await extractToken(cookie, method);
    if (token) return res.json({ success: true, token });
    res.status(400).json({ success: false, message: 'Failed to extract token — cookie may be expired or blocked' });
});

// POST /share/get-post-id
// Extract numeric post ID from a Facebook URL.
// body: { link }
app.post('/share/get-post-id', async (req, res) => {
    const { link } = req.body;
    if (!link) return res.status(400).json({ success: false, message: 'link is required' });

    let postId = extractPostId(link);
    if (/^\d+$/.test(postId)) return res.json({ success: true, postId });

    postId = await getPostIdFromApi(link);
    if (postId) return res.json({ success: true, postId });

    res.status(400).json({ success: false, message: 'Could not extract post ID from link' });
});

// POST /share/execute
// Single share with optional speed delay.
// body: { cookie, token, postId, method? ('smm'|'normal'), speed? ('instant'|'fast'|'slow') }
app.post('/share/execute', async (req, res) => {
    const { cookie, token, postId, method, speed } = req.body;
    if (!cookie || !token || !postId) {
        return res.status(400).json({ success: false, message: 'cookie, token, and postId are required' });
    }

    const delay = getShareDelay(speed);
    if (delay > 0) await sleep(delay);

    const result = method === 'smm'
        ? await smmShare(cookie, token, postId)
        : await sharePost(cookie, token, postId);

    res.json({ ...result, speed: speed || 'instant', delayMs: delay });
});

// POST /share/batch
// Run multiple accounts sharing in parallel with per-account speed delay.
// body: { accounts: [{cookie, token, name?, uid?}], postId, method?, targetCount?, speed? }
// Speed delay is applied AFTER each successful share per account:
//   instant (DEFAULT) — no delay, maximum speed
//   fast              — 2000ms between each share per account
//   slow              — 3000ms between each share per account
app.post('/share/batch', async (req, res) => {
    const { accounts, postId, method, targetCount, speed } = req.body;

    if (!accounts?.length || !postId) {
        return res.status(400).json({ success: false, message: 'accounts (array) and postId are required' });
    }

    const sessionId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    activeSessions.set(sessionId, {
        status      : 'running',
        successCount: 0,
        failCount   : 0,
        targetCount : targetCount || null,
        speed       : speed || 'instant',
        logs        : [],
        accounts,
        createdAt   : Date.now()
    });

    // Respond immediately — sharing runs in background
    res.json({
        success     : true,
        sessionId,
        speed       : speed || 'instant',
        delayMs     : getShareDelay(speed),
        accountCount: accounts.length,
        targetCount : targetCount || null
    });

    runBatchShare(sessionId, accounts, postId, method, targetCount, speed);
});

async function runBatchShare(sessionId, accounts, postId, method, targetCount, speed) {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    const delay = getShareDelay(speed);
    const limit = targetCount || Infinity;

    // Each account runs its own loop in parallel
    const promises = accounts.map(async (account) => {
        while (session.status === 'running' && session.successCount < limit) {
            const result = method === 'smm'
                ? await smmShare(account.cookie, account.token, postId)
                : await sharePost(account.cookie, account.token, postId);

            const log = {
                time   : new Date().toISOString(),
                account: account.name || account.uid || 'Unknown',
                success: result.success,
                message: result.success
                    ? `Shared — ID: ${result.id}`
                    : `Failed — ${result.error}`
            };

            session.logs.push(log);
            if (session.logs.length > 500) session.logs.shift(); // cap memory

            if (result.success) {
                session.successCount++;
            } else {
                session.failCount++;
                break; // stop this account on error; other accounts continue
            }

            if (session.successCount >= limit) {
                session.status = 'completed';
                break;
            }

            if (delay > 0) await sleep(delay);
        }
    });

    await Promise.all(promises);
    if (session.status === 'running') session.status = 'completed';
}

// GET /share/session/:sessionId — poll live session status + recent logs
app.get('/share/session/:sessionId', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    res.json({
        success     : true,
        status      : session.status,
        successCount: session.successCount,
        failCount   : session.failCount,
        targetCount : session.targetCount,
        speed       : session.speed,
        delayMs     : getShareDelay(session.speed),
        logs        : session.logs.slice(-100)   // last 100 entries
    });
});

// POST /share/session/:sessionId/stop — stop an active session
app.post('/share/session/:sessionId/stop', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    session.status = 'stopped';
    res.json({ success: true, message: 'Session stopped', sessionId: req.params.sessionId });
});

// GET /share/sessions — list all tracked sessions (admin/debug)
app.get('/share/sessions', (req, res) => {
    const sessions = [];
    for (const [id, s] of activeSessions.entries()) {
        sessions.push({
            sessionId   : id,
            status      : s.status,
            successCount: s.successCount,
            failCount   : s.failCount,
            targetCount : s.targetCount,
            speed       : s.speed,
            accountCount: s.accounts?.length || 0,
            createdAt   : new Date(s.createdAt).toISOString()
        });
    }
    res.json({ success: true, count: sessions.length, sessions });
});

// =============================================================================
//  UID LIVE CHECK  (hitools.pro — local, not proxied to server.js)
// =============================================================================

const HITOOLS_HEADERS = {
    'Content-Type': 'application/json',
    'User-Agent'  : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Accept'      : '*/*',
    'Origin'      : 'https://hitools.pro',
};

// Retry helper for 429 rate limits
async function requestWithRetry(config, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios(config);
        } catch (err) {
            if (err.response && err.response.status === 429 && i < retries - 1) {
                console.log(`  Rate limited (429). Retrying in ${delay}ms... (${i + 1}/${retries})`);
                await new Promise(r => setTimeout(r, delay));
                delay *= 1.5; // exponential backoff
            } else {
                throw err;
            }
        }
    }
}

// POST /api/check-uid
// Check if Facebook UIDs are live or dead via hitools.pro
// body: { uids: string[] }  — max 50 per request
// response: { success, results: [{ uid, live }] }
app.post('/api/check-uid', async (req, res) => {
    try {
        const { uids } = req.body;
        if (!uids || !Array.isArray(uids) || uids.length === 0) {
            return res.status(400).json({ success: false, error: 'uids array is required' });
        }
        if (uids.length > 50) {
            return res.status(400).json({ success: false, error: 'Maximum 50 UIDs per request' });
        }

        const cleanUids = uids.map(String);
        console.log(`[check-uid] Checking ${cleanUids.length} UIDs:`, cleanUids);

        let rawResponse;
        try {
            // Try with responseType: 'text' first (handles NDJSON correctly)
            rawResponse = await requestWithRetry({
                method      : 'POST',
                url         : 'https://hitools.pro/api/check-uid-facebook',
                data        : { uids: cleanUids },
                headers     : { ...HITOOLS_HEADERS, Referer: 'https://hitools.pro/check-live-uid' },
                timeout     : 30000,
                responseType: 'text',
            });
        } catch (axiosErr) {
            // If text mode fails try without responseType
            console.warn('[check-uid] text mode failed, retrying as json:', axiosErr.message);
            rawResponse = await requestWithRetry({
                method  : 'POST',
                url     : 'https://hitools.pro/api/check-uid-facebook',
                data    : { uids: cleanUids },
                headers : { ...HITOOLS_HEADERS, Referer: 'https://hitools.pro/check-live-uid' },
                timeout : 30000,
            });
        }

        const responseData = rawResponse.data;
        console.log('[check-uid] Raw response type:', typeof responseData);
        console.log('[check-uid] Raw response:', String(responseData).substring(0, 500));

        let results = [];

        if (Array.isArray(responseData)) {
            // Already a parsed array
            results = responseData;
            console.log('[check-uid] Format: JSON array');

        } else if (typeof responseData === 'object' && responseData !== null) {
            // Single object
            results = [responseData];
            console.log('[check-uid] Format: single object');

        } else {
            // String — could be NDJSON (one object per line) or regular JSON
            const raw = String(responseData || '').trim();

            // Try regular JSON first
            try {
                const parsed = JSON.parse(raw);
                results = Array.isArray(parsed) ? parsed : [parsed];
                console.log('[check-uid] Format: JSON string →', results.length, 'items');
            } catch {
                // Fall back to NDJSON (newline-delimited JSON)
                results = raw
                    .split(/\r?\n/)          // handle both \n and \r\n
                    .map(l => l.trim())
                    .filter(Boolean)
                    .map(line => {
                        try { return JSON.parse(line); }
                        catch (e) {
                            console.warn('[check-uid] Failed to parse line:', line);
                            return null;
                        }
                    })
                    .filter(Boolean);
                console.log('[check-uid] Format: NDJSON →', results.length, 'items');
            }
        }

        // Normalize — ensure uid field is present and live is boolean
        results = results
            .filter(r => r && (r.uid !== undefined))
            .map(r => ({ uid: String(r.uid), live: Boolean(r.live) }));

        console.log(`[check-uid] Final: ${results.length} results`, results);

        if (results.length === 0) {
            console.warn('[check-uid] WARNING: 0 results for', cleanUids.length, 'UIDs. Raw was:', String(responseData).substring(0, 200));
        }

        return res.json({ success: true, results, requested: cleanUids.length });

    } catch (err) {
        console.error('[check-uid] Error:', err.message, err.response?.data);
        const status = err.response?.status || 500;
        return res.status(status).json({
            success: false,
            error  : status === 429
                ? 'Rate limited. Please wait a moment and try again.'
                : 'Failed to check UIDs: ' + err.message,
            details: err.message
        });
    }
});

// =============================================================================
//  UTILITY ROUTES
// =============================================================================

// GET /detect-country — detect server IP location
app.get('/detect-country', async (req, res) => {
    try {
        const r = await axios.get('http://ip-api.com/json/', { timeout: 5000 });
        res.json({
            success    : true,
            country    : r.data.country     || 'Philippines',
            countryCode: r.data.countryCode || 'PH',
            city       : r.data.city        || '',
            region     : r.data.regionName  || ''
        });
    } catch {
        res.json({ success: true, country: 'Philippines', countryCode: 'PH' });
    }
});

// GET /health — check this server + API backend connectivity
app.get('/health', async (req, res) => {
    let apiStatus  = 'unknown';
    let apiLatency = null;
    try {
        const t0 = Date.now();
        await axios.get(`${API_URL}/health`, { timeout: 6000 });
        apiLatency = Date.now() - t0;
        apiStatus  = 'connected';
    } catch {
        apiStatus = 'unreachable';
    }

    res.json({
        success       : true,
        server        : 'running',
        api           : apiStatus,
        apiUrl        : API_URL,
        apiLatencyMs  : apiLatency,
        activeSessions: activeSessions.size,
        uptimeSeconds : Math.floor(process.uptime()),
        timestamp     : new Date().toISOString()
    });
});

// =============================================================================
//  PAGE ROUTES
// =============================================================================

app.get('/',             (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/login',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/home',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/boost',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'boost.html')));
app.get('/cookies',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'cookies.html')));
app.get('/inbox',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'inbox.html')));
app.get('/transactions', (req, res) => res.sendFile(path.join(__dirname, 'public', 'transactions.html')));
app.get('/profile',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/limits',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'limits.html')));
app.get('/admin',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// =============================================================================
//  START SERVER
// =============================================================================

app.listen(PORT, () => {
    console.log(`\n✅  KiroBoost Web Server  →  http://localhost:${PORT}`);
    console.log(`🔗  Backend API           →  ${API_URL}`);
    console.log(`⚡  Share speed modes     →  instant (0ms) | fast (2s) | slow (3s)`);
    console.log(`📦  API routes proxied    →  45 endpoints from server.js`);
    console.log(`🔄  Share engine          →  batch | execute | sessions | token extraction\n`);
});
