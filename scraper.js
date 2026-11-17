require('dotenv').config();
const { connect } = require('puppeteer-real-browser');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const USERNAME = process.env.REDDIT_USERNAME;
const PASSWORD = process.env.REDDIT_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('Set REDDIT_USERNAME and REDDIT_PASSWORD in .env');
  process.exit(1);
}

const TARGET_URL = process.argv[2];
if (!TARGET_URL) {
  console.error('Usage: node scraper.js <post or subreddit URL>');
  process.exit(1);
}

const OUTPUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function detectUrlType(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.includes('comments')) {
      const rIdx = parts.indexOf('r');
      const cIdx = parts.indexOf('comments');
      return {
        type: 'post',
        subreddit: parts[rIdx + 1],
        postId: parts[cIdx + 1],
      };
    }
    if (parts[0] === 'r') {
      return {
        type: 'subreddit',
        subreddit: parts[1],
      };
    }
  } catch (_) {}
  console.error('Invalid Reddit URL');
  process.exit(1);
}

async function loginAndGetSession() {
  const { browser, page } = await connect({
    headless: false,
    turnstile: true,
    disableXvfb: true,
    args: ['--start-maximized'],
    customConfig: {},
    connectOption: {},
  });

  await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  const cookies = await page.cookies();
  const csrfCookie = cookies.find(c => c.name === 'csrf_token');
  const csrfToken = csrfCookie ? csrfCookie.value : null;

  const loginBody = new URLSearchParams({
    username: USERNAME,
    password: PASSWORD,
    csrf_token: csrfToken || '',
    recaptcha_use_checkbox: 'false',
    recaptcha_action: 'v1/web/login_with_password',
  });

  await page.evaluate(async (body) => {
    await fetch('/svc/shreddit/account/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'accept': 'text/vnd.reddit.partial+html, application/json',
      },
      body,
    });
  }, loginBody.toString());

  await new Promise(r => setTimeout(r, 2500));

  const allCookies = await page.cookies();
  const sessionCookieStr = allCookies.map(c => `${c.name}=${c.value}`).join('; ');
  const newCsrf = allCookies.find(c => c.name === 'csrf_token');

  await browser.close();

  return {
    cookieStr: sessionCookieStr,
    csrfToken: newCsrf ? newCsrf.value : csrfToken,
  };
}

function buildHeaders(session, referer = 'https://www.reddit.com/') {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'accept': 'text/vnd.reddit.partial+html, text/html;q=0.9',
    'content-type': 'application/x-www-form-urlencoded',
    'Referer': referer,
    'cookie': session.cookieStr,
    'x-reddit-client-version': '2026-03-20T17:06Z~2639b6d2',
    'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

function parseComments(html) {
  const $ = cheerio.load(html);
  const comments = [];

  $('shreddit-comment').each((_, el) => {
    const $el = $(el);
    const author = $el.attr('author') || '[deleted]';
    const score = $el.attr('score') || '?';
    const depth = parseInt($el.attr('depth') || '0');
    const thingId = $el.attr('thingid') || '';
    const permalink = $el.attr('permalink') || '';
    const created = $el.attr('created') || '';

    const contentDiv = $el.find('[id$="-post-rtjson-content"]').first();
    const text = contentDiv.text().trim().replace(/\s+/g, ' ') || '[no text]';

    comments.push({ author, score, depth, thingId, permalink, created, text });
  });

  return comments;
}

function parseMoreCommentsCursors(html) {
  const $ = cheerio.load(html);
  const cursors = [];

  $('faceplate-partial[src*="more-comments"]').each((_, el) => {
    const src = $(el).attr('src') || '';
    const cursorInput = $(el).find('input[name="cursor"]');
    const cursor = cursorInput.attr('value');
    if (cursor && src) {
      cursors.push({ src, cursor });
    }
  });

  return cursors;
}

async function scrapeAllComments(subreddit, postId, session, outStream, label = '') {
  const referer = `https://www.reddit.com/r/${subreddit}/comments/${postId}/`;
  const initialUrl = `https://www.reddit.com/svc/shreddit/comments/r/${subreddit}/${postId}?seeker-session=false&render-mode=partial&referer=${encodeURIComponent(referer)}`;

  if (label) outStream.write(`\n${label}\n\n`);

  let totalComments = 0;

  const queue = [{ url: initialUrl, method: 'GET', body: null }];
  const visited = new Set();

  while (queue.length > 0) {
    const { url, method, body } = queue.shift();

    if (visited.has(url + (body || ''))) continue;
    visited.add(url + (body || ''));

    try {
      const resp = await fetch(url, {
        method,
        headers: buildHeaders(session, referer),
        body: body || undefined,
      });

      if (!resp.ok) {
        console.error(`HTTP ${resp.status}: ${url}`);
        continue;
      }

      const html = await resp.text();

      const comments = parseComments(html);
      for (const c of comments) {
        const indent = '  '.repeat(c.depth);
        const line = `${indent}[${c.author}] (score: ${c.score}) ${c.created ? '| ' + c.created.split('T')[0] : ''}\n${indent}${c.text}\n\n`;
        outStream.write(line);
        totalComments++;
      }

      const moreCursors = parseMoreCommentsCursors(html);
      for (const { src, cursor } of moreCursors) {
        const moreUrl = src.startsWith('http') ? src : `https://www.reddit.com${src}`;
        const moreBody = new URLSearchParams({
          cursor,
          csrf_token: session.csrfToken,
        }).toString();

        queue.push({ url: moreUrl, method: 'POST', body: moreBody });
      }

      await new Promise(r => setTimeout(r, 400));

    } catch (err) {
      console.error(`Request failed: ${err.message}`);
    }
  }

  console.log(`Post ${postId}: ${totalComments} comments`);
  return totalComments;
}

async function getTopPosts(subreddit, session, limit = 5) {
  const url = `https://www.reddit.com/svc/shreddit/feeds/${subreddit}-feed?sort=HOT&distance=0&navigationSessionId=scraper-${Date.now()}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(session, `https://www.reddit.com/r/${subreddit}/`),
  });

  if (!resp.ok) {
    const resp2 = await fetch(`https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`, {
      headers: {
        'User-Agent': buildHeaders(session)['User-Agent'],
        'cookie': session.cookieStr,
      },
    });
    if (resp2.ok) {
      const json = await resp2.json();
      return json.data.children.slice(0, limit).map(p => ({
        postId: p.data.id,
        title: p.data.title,
        score: p.data.score,
        comments: p.data.num_comments,
      }));
    }
    throw new Error(`HTTP ${resp.status} for r/${subreddit}`);
  }

  const html = await resp.text();
  const $ = cheerio.load(html);
  const posts = [];

  $('shreddit-post').each((_, el) => {
    if (posts.length >= limit) return false;
    const $el = $(el);
    const permalink = $el.attr('permalink') || '';
    const match = permalink.match(/\/r\/\w+\/comments\/(\w+)\//);
    if (!match) return;
    posts.push({
      postId: match[1],
      title: $el.attr('post-title') || 'Untitled',
      score: $el.attr('score') || '?',
      comments: $el.attr('comment-count') || '?',
    });
  });

  if (posts.length === 0) {
    const resp3 = await fetch(`https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`, {
      headers: {
        'User-Agent': buildHeaders(session)['User-Agent'],
        'cookie': session.cookieStr,
      },
    });
    if (resp3.ok) {
      const json = await resp3.json();
      return json.data.children.slice(0, limit).map(p => ({
        postId: p.data.id,
        title: p.data.title,
        score: p.data.score,
        comments: p.data.num_comments,
      }));
    }
  }

  return posts;
}

(async () => {
  const urlInfo = detectUrlType(TARGET_URL);
  const session = await loginAndGetSession();

  if (urlInfo.type === 'post') {
    const outFile = path.join(OUTPUT_DIR, `post_${urlInfo.postId}.txt`);
    const outStream = fs.createWriteStream(outFile, { flags: 'w' });

    outStream.write(`Reddit Scraper\nURL: ${TARGET_URL}\nExtracted: ${new Date().toISOString()}\n\n`);

    const total = await scrapeAllComments(urlInfo.subreddit, urlInfo.postId, session, outStream);
    outStream.end();

    console.log(`Saved: ${outFile} (${total} comments)`);
  } else {
    const outFile = path.join(OUTPUT_DIR, `subreddit_${urlInfo.subreddit}_top5.txt`);
    const outStream = fs.createWriteStream(outFile, { flags: 'w' });

    outStream.write(`Reddit Scraper\nURL: ${TARGET_URL}\nSubreddit: r/${urlInfo.subreddit} (top 5)\nExtracted: ${new Date().toISOString()}\n\n`);

    const posts = await getTopPosts(urlInfo.subreddit, session, 5);

    outStream.write(`Top posts:\n`);
    posts.forEach((p, i) => {
      outStream.write(`  ${i + 1}. ${p.title} (score: ${p.score}, comments: ${p.comments})\n`);
    });

    let grandTotal = 0;
    for (let i = 0; i < posts.length; i++) {
      const p = posts[i];
      const label = `POST ${i + 1}/${posts.length}: ${p.title}\nhttps://www.reddit.com/r/${urlInfo.subreddit}/comments/${p.postId}/`;
      const n = await scrapeAllComments(urlInfo.subreddit, p.postId, session, outStream, label);
      grandTotal += n;
    }

    outStream.end();

    console.log(`Saved: ${outFile} (${grandTotal} comments)`);
  }
})();
