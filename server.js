const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// API Configuration - Your KiroBoost API
const API_URL = process.env.API_URL || 'https://kiroboost-api.vercel.app';

// Headers configuration matching the Python script exactly
const FB_HEADERS = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="107", "Chromium";v="107", "Not=A?Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1'
};

const SHARE_HEADERS = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="107", "Chromium";v="107", "Not=A?Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'accept-encoding': 'gzip, deflate',
    'host': 'b-graph.facebook.com'
};

const BUSINESS_HEADERS = {
    'user-agent': 'Mozilla/5.0 (Linux; Android 8.1.0; MI 8 Build/OPM1.171019.011) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.86 Mobile Safari/537.36',
    'referer': 'https://www.facebook.com/',
    'host': 'business.facebook.com',
    'origin': 'https://business.facebook.com',
    'upgrade-insecure-requests': '1',
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'cache-control': 'max-age=0',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'content-type': 'text/html; charset=utf-8'
};

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Store active sharing sessions
const activeSessions = new Map();

// ============ UTILITY FUNCTIONS ============

function extractPostId(link) {
    link = link.trim();
    if (/^\d+$/.test(link)) return link;
    
    link = link.replace(/^https?:\/\//i, '');
    link = link.replace(/^(www\.|m\.)/i, '');
    
    const patterns = [
        /facebook\.com\/.*?\/posts\/(\d+)/,
        /facebook\.com\/.*?\/photos\/.*?\/(\d+)/,
        /facebook\.com\/permalink\.php\?story_fbid=(\d+)/,
        /facebook\.com\/story\.php\?story_fbid=(\d+)/,
        /facebook\.com\/photo\.php\?fbid=(\d+)/,
        /\/(\d+)\/?$/
    ];
    
    for (const pattern of patterns) {
        const match = link.match(pattern);
        if (match) return match[1];
    }
    return link;
}

// ============ TOKEN EXTRACTION ============

async function getTokenFromContentManagement(cookie) {
    try {
        const response = await axios.get('https://business.facebook.com/content_management', {
            headers: { ...FB_HEADERS, cookie },
            timeout: 15000,
            maxRedirects: 5
        });
        const match = response.data.match(/EAAG(.*?)"/);
        return match ? 'EAAG' + match[1] : null;
    } catch (error) {
        return null;
    }
}

async function getTokenFromBusinessLocations(cookie) {
    try {
        const response = await axios.get('https://business.facebook.com/business_locations', {
            headers: { ...BUSINESS_HEADERS, cookie },
            timeout: 15000,
            maxRedirects: 5
        });
        const match = response.data.match(/(EAAG\w+)/);
        return match ? match[1] : null;
    } catch (error) {
        return null;
    }
}

// ============ POST ID EXTRACTION ============

async function getPostIdFromApi(link) {
    try {
        const response = await axios.post('https://id.traodoisub.com/api.php', 
            `link=${encodeURIComponent(link)}`,
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000
            }
        );
        if (response.data && response.data.id) {
            return response.data.id;
        }
        return null;
    } catch (error) {
        return null;
    }
}

// ============ SHARING FUNCTIONS - NO DELAY ============

async function sharePost(cookie, token, postId) {
    try {
        const url = `https://b-graph.facebook.com/me/feed?link=https://mbasic.facebook.com/${postId}&published=0&access_token=${token}`;
        const response = await axios.post(url, null, {
            headers: { ...SHARE_HEADERS, cookie },
            timeout: 10000
        });
        
        if (response.data && response.data.id) {
            return { success: true, id: response.data.id };
        }
        return { success: false, error: response.data?.error?.message || 'Unknown error' };
    } catch (error) {
        return { success: false, error: error.response?.data?.error?.message || error.message };
    }
}

async function smmShare(cookie, token, postLink) {
    try {
        const url = `https://b-graph.facebook.com/me/feed?link=${postLink}&published=0&access_token=${token}`;
        const response = await axios.post(url, null, {
            headers: { ...SHARE_HEADERS, cookie },
            timeout: 10000
        });
        
        if (response.data && response.data.id) {
            return { success: true, id: response.data.id };
        }
        return { success: false, error: response.data?.error?.message || 'Unknown error' };
    } catch (error) {
        return { success: false, error: error.response?.data?.error?.message || error.message };
    }
}

// ============ API PROXY ROUTES ============

// Proxy all API requests to KiroBoost API
app.use('/api', async (req, res) => {
    try {
        const url = `${API_URL}${req.originalUrl}`;
        const config = {
            method: req.method,
            url,
            headers: {
                'Content-Type': 'application/json',
                ...(req.headers.authorization && { 'Authorization': req.headers.authorization })
            },
            timeout: 30000
        };

        if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
            config.data = req.body;
        }

        const response = await axios(config);
        res.status(response.status).json(response.data);
    } catch (error) {
        const status = error.response?.status || 500;
        const data = error.response?.data || { success: false, message: error.message };
        res.status(status).json(data);
    }
});

// ============ SHARING ENGINE ROUTES ============

// Extract token from cookie
app.post('/share/extract-token', async (req, res) => {
    const { cookie, method } = req.body;
    
    if (!cookie) {
        return res.status(400).json({ success: false, message: 'Cookie is required' });
    }
    
    let token = null;
    
    if (method === 'smm' || method === 'content_management') {
        token = await getTokenFromContentManagement(cookie);
    }
    
    if (!token) {
        token = await getTokenFromBusinessLocations(cookie);
    }
    
    if (token) {
        res.json({ success: true, token });
    } else {
        res.status(400).json({ success: false, message: 'Failed to extract token' });
    }
});

// Get post ID
app.post('/share/get-post-id', async (req, res) => {
    const { link } = req.body;
    
    if (!link) {
        return res.status(400).json({ success: false, message: 'Link is required' });
    }
    
    let postId = extractPostId(link);
    
    if (/^\d+$/.test(postId)) {
        return res.json({ success: true, postId });
    }
    
    postId = await getPostIdFromApi(link);
    
    if (postId) {
        res.json({ success: true, postId });
    } else {
        res.status(400).json({ success: false, message: 'Failed to extract post ID' });
    }
});

// Single share request - NO DELAY
app.post('/share/execute', async (req, res) => {
    const { cookie, token, postId, method } = req.body;
    
    if (!cookie || !token || !postId) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    let result;
    if (method === 'smm') {
        result = await smmShare(cookie, token, postId);
    } else {
        result = await sharePost(cookie, token, postId);
    }
    
    res.json(result);
});

// Batch share - NO DELAY, PARALLEL EXECUTION
app.post('/share/batch', async (req, res) => {
    const { accounts, postId, method, targetCount } = req.body;
    
    if (!accounts || !accounts.length || !postId) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    const sessionId = Date.now().toString();
    activeSessions.set(sessionId, {
        status: 'running',
        successCount: 0,
        failCount: 0,
        targetCount: targetCount || Infinity,
        logs: [],
        accounts
    });
    
    res.json({ success: true, sessionId });
    
    // Start sharing in background - NO DELAYS
    runBatchShare(sessionId, accounts, postId, method, targetCount);
});

async function runBatchShare(sessionId, accounts, postId, method, targetCount) {
    const session = activeSessions.get(sessionId);
    if (!session) return;
    
    // Run all accounts in parallel - NO DELAY
    const sharePromises = accounts.map(async (account) => {
        while (session.status === 'running' && session.successCount < (targetCount || Infinity)) {
            const result = method === 'smm' 
                ? await smmShare(account.cookie, account.token, postId)
                : await sharePost(account.cookie, account.token, postId);
            
            const logEntry = {
                time: new Date().toISOString(),
                account: account.name || account.uid,
                success: result.success,
                message: result.success ? `Share ID: ${result.id}` : result.error
            };
            
            session.logs.push(logEntry);
            
            if (result.success) {
                session.successCount++;
            } else {
                session.failCount++;
                break; // Stop this account on error
            }
            
            if (session.successCount >= (targetCount || Infinity)) {
                session.status = 'completed';
                break;
            }
            
            // NO DELAY - Continue immediately
        }
    });
    
    await Promise.all(sharePromises);
    
    if (session.status === 'running') {
        session.status = 'completed';
    }
}

// Get session status
app.get('/share/session/:sessionId', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    
    if (!session) {
        return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    res.json({
        success: true,
        status: session.status,
        successCount: session.successCount,
        failCount: session.failCount,
        targetCount: session.targetCount,
        logs: session.logs.slice(-100)
    });
});

// Stop session
app.post('/share/session/:sessionId/stop', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    
    if (!session) {
        return res.status(404).json({ success: false, message: 'Session not found' });
    }
    
    session.status = 'stopped';
    res.json({ success: true, message: 'Session stopped' });
});

// Get country from IP - Auto detect
app.get('/detect-country', async (req, res) => {
    try {
        const response = await axios.get('http://ip-api.com/json/', { timeout: 5000 });
        res.json({ 
            success: true, 
            country: response.data.country || 'Philippines',
            countryCode: response.data.countryCode || 'PH',
            city: response.data.city || '',
            region: response.data.regionName || ''
        });
    } catch {
        res.json({ success: true, country: 'Philippines', countryCode: 'PH' });
    }
});

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/boost', (req, res) => res.sendFile(path.join(__dirname, 'public', 'boost.html')));
app.get('/cookies', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cookies.html')));
app.get('/inbox', (req, res) => res.sendFile(path.join(__dirname, 'public', 'inbox.html')));
app.get('/transactions', (req, res) => res.sendFile(path.join(__dirname, 'public', 'transactions.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/limits', (req, res) => res.sendFile(path.join(__dirname, 'public', 'limits.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Start server
app.listen(PORT, () => {
    console.log(`✅ Kiroboost Web Server running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT}`);
});
