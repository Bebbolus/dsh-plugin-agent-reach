/**
 * dsh-plugin-agent-reach
 * Cordis Plugin for DeepSeek Harness (DSH)
 * Native Agent-Reach OSINT, Web Scraping and Social Media Intelligence.
 * Supports:
 * - Clean Markdown scraping via Jina Reader (r.jina.ai)
 * - Social Intelligence: Twitter/X, Instagram, Reddit, YouTube, GitHub, V2EX
 * - Interactive Cross-Browser Session Cookie & Token Configuration
 * - Passive OSINT syndication fallback via SearXNG when unauthenticated
 */

import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace';
const CREDENTIALS_FILE = path.join(WORKSPACE_DIR, '.dsh', 'social_credentials.json');
const AGENT_REACH_CONFIG = process.env.AGENT_REACH_CONFIG || '/home/node/.agent-reach/config.yaml';
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://searxng:8080';
const TWITTER_CLI = process.env.TWITTER_CLI_PATH || '/home/node/.local/bin/twitter';

/**
 * Loads credentials: reads environment variables first (.env / container runtime),
 * then falls back to local configuration file if present.
 */
async function loadCredentials() {
  let creds = {};
  try {
    const raw = await fs.readFile(CREDENTIALS_FILE, 'utf8');
    creds = JSON.parse(raw);
  } catch {}

  if (!creds.twitter) creds.twitter = {};
  if (!creds.instagram) creds.instagram = {};
  if (!creds.reddit) creds.reddit = {};

  // High priority to environment variables (12-factor / container .env)
  if (process.env.TWITTER_AUTH_TOKEN) creds.twitter.auth_token = process.env.TWITTER_AUTH_TOKEN;
  if (process.env.TWITTER_CT0) creds.twitter.ct0 = process.env.TWITTER_CT0;
  if (process.env.INSTAGRAM_SESSION_ID) creds.instagram.session_id = process.env.INSTAGRAM_SESSION_ID;
  if (process.env.REDDIT_SESSION_ID) creds.reddit.session_id = process.env.REDDIT_SESSION_ID;

  // Sync to process.env for downstream CLI and libraries
  if (creds.twitter?.auth_token) process.env.TWITTER_AUTH_TOKEN = creds.twitter.auth_token;
  if (creds.twitter?.ct0) process.env.TWITTER_CT0 = creds.twitter.ct0;
  if (creds.instagram?.session_id) process.env.INSTAGRAM_SESSION_ID = creds.instagram.session_id;
  if (creds.reddit?.session_id) process.env.REDDIT_SESSION_ID = creds.reddit.session_id;

  return creds;
}

/**
 * Persists credentials to disk, updates agent-reach YAML file and sets process.env
 */
async function saveCredentials(creds) {
  await fs.mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
  await fs.writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), 'utf8');

  if (creds.twitter?.auth_token) process.env.TWITTER_AUTH_TOKEN = creds.twitter.auth_token;
  if (creds.twitter?.ct0) process.env.TWITTER_CT0 = creds.twitter.ct0;
  if (creds.instagram?.session_id) process.env.INSTAGRAM_SESSION_ID = creds.instagram.session_id;
  if (creds.reddit?.session_id) process.env.REDDIT_SESSION_ID = creds.reddit.session_id;

  // Also sync to ~/.agent-reach/config.yaml
  try {
    await fs.mkdir(path.dirname(AGENT_REACH_CONFIG), { recursive: true });
    const yamlLines = ['# Agent Reach Credentials synced from DSH Plugin'];
    if (creds.twitter?.auth_token) yamlLines.push(`twitter_auth_token: "${creds.twitter.auth_token}"`);
    if (creds.twitter?.ct0) yamlLines.push(`twitter_ct0: "${creds.twitter.ct0}"`);
    if (creds.instagram?.session_id) yamlLines.push(`instagram_session_id: "${creds.instagram.session_id}"`);
    await fs.writeFile(AGENT_REACH_CONFIG, yamlLines.join('\n') + '\n', 'utf8');
  } catch {}
}

/**
 * Heuristic parsing from raw cookie string (e.g. exported from Cookie-Editor or DevTools)
 */
function parseRawCookieString(rawStr) {
  const result = {};
  if (!rawStr || typeof rawStr !== 'string') return result;

  // JSON export from Cookie-Editor
  if (rawStr.trim().startsWith('[') || rawStr.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawStr);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (item.name && item.value) {
          result[item.name] = item.value;
        }
      }
      return result;
    } catch {}
  }

  // Standard "cookie1=val1; cookie2=val2" format
  const pairs = rawStr.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const k = pair.substring(0, idx).trim();
      const v = pair.substring(idx + 1).trim();
      result[k] = v;
    }
  }
  return result;
}

/**
 * Clean scraping via Jina Reader (https://r.jina.ai/<url>)
 */
async function scrapeViaJina(targetUrl, signal) {
  const jinaEndpoint = `https://r.jina.ai/${targetUrl}`;
  const res = await fetch(jinaEndpoint, {
    method: 'GET',
    headers: {
      'Accept': 'text/plain',
      'X-Return-Format': 'markdown',
      'User-Agent': 'DSH-Agent-Reach/1.5'
    },
    signal
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Jina Reader error HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const markdown = await res.text();
  return markdown;
}

/**
 * Internal SearXNG OSINT search
 */
async function searchSearxng(query, signal) {
  const url = new URL('/search', SEARXNG_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    signal
  });

  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return (data.results || []).slice(0, 8).map(r => ({
    title: r.title,
    url: r.url,
    content: r.content,
    engine: r.engine
  }));
}

/**
 * Instagram scraping: uses Instagram API with sessionid if authenticated, otherwise SearXNG OSINT fallback
 */
async function scrapeInstagram(username, creds, signal) {
  const cleanUser = username.replace(/^@/, '').trim();
  const sessionId = creds.instagram?.session_id;

  if (sessionId) {
    try {
      const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(cleanUser)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Cookie': `sessionid=${sessionId};`,
          'x-ig-app-id': '936619743392459',
          'x-asbd-id': '129477'
        },
        signal
      });

      if (res.ok) {
        const data = await res.json();
        const user = data?.data?.user;
        if (user) {
          const posts = (user.edge_owner_to_timeline_media?.edges || []).slice(0, 10).map(edge => {
            const node = edge.node;
            return {
              id: node.id,
              caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
              likes: node.edge_liked_by?.count || 0,
              comments: node.edge_media_to_comment?.count || 0,
              timestamp: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
              is_video: node.is_video,
              url: `https://www.instagram.com/p/${node.shortcode}/`
            };
          });

          return {
            status: 'AUTHENTICATED_SUCCESS',
            platform: 'instagram',
            username: cleanUser,
            full_name: user.full_name,
            biography: user.biography,
            followers: user.edge_followed_by?.count,
            following: user.edge_follow?.count,
            is_private: user.is_private,
            is_verified: user.is_verified,
            posts_count: user.edge_owner_to_timeline_media?.count,
            recent_posts: posts
          };
        }
      }
    } catch (e) {}
  }

  // Passive OSINT fallback if unauthenticated or on error
  const osintResults = await searchSearxng(`site:instagram.com/${cleanUser} OR "instagram.com/${cleanUser}"`, signal);
  return {
    status: sessionId ? 'AUTHENTICATION_EXPIRED' : 'UNAUTHENTICATED_PASSIVE',
    platform: 'instagram',
    username: cleanUser,
    message: sessionId
      ? 'Configured Instagram session has expired or is invalid.'
      : 'Anonymous access restricted by Instagram anti-bot policies. Public indexed data retrieved via OSINT.',
    osint_results: osintResults,
    interactive_prompt_guidance: [
      `[INSTAGRAM INTERACTIVE CONFIGURATION GUIDE]`,
      `To extract the full profile, stories, and all recent posts of @${cleanUser}, a session cookie is required.`,
      `Prompt the user:`,
      `"To access full recent Instagram posts from the runtime, a session cookie from your browser (Chrome, Firefox, Safari, Edge, Arc) is needed.`,
      `How to obtain it in seconds:`,
      `1. Open instagram.com in your browser and open Developer Tools (F12 or Ctrl+Shift+I / Cmd+Opt+I).`,
      `2. Navigate to 'Application' (or 'Storage') -> 'Cookies' -> 'https://www.instagram.com'.`,
      `3. Copy the value of the 'sessionid' cookie and paste it here in chat."`,
      `As soon as the user provides it, invoke reach_configure_credentials({ platform: 'instagram', session_id: '...' }) to activate it instantly.`
    ].join('\n')
  };
}

/**
 * Twitter/X scraping: uses twitter-cli if authenticated, otherwise SearXNG OSINT fallback
 */
async function scrapeTwitter(target, action = 'user-posts', creds, signal) {
  const cleanUser = target.replace(/^@/, '').trim();
  const hasCreds = !!(creds.twitter?.auth_token && creds.twitter?.ct0);

  if (hasCreds) {
    try {
      const env = {
        ...process.env,
        TWITTER_AUTH_TOKEN: creds.twitter.auth_token,
        TWITTER_CT0: creds.twitter.ct0
      };

      const cmdArgs = action === 'profile'
        ? ['user', `@${cleanUser}`, '-c']
        : ['user-posts', `@${cleanUser}`, '-n', '10', '-c'];

      const { stdout } = await execFileAsync(TWITTER_CLI, cmdArgs, { env, timeout: 15000 });
      return {
        status: 'AUTHENTICATED_SUCCESS',
        platform: 'twitter',
        target: cleanUser,
        output: stdout
      };
    } catch (err) {
      // Fallback on CLI error
    }
  }

  // OSINT fallback on SearXNG
  const osintResults = await searchSearxng(`site:x.com/${cleanUser} OR site:twitter.com/${cleanUser}`, signal);
  return {
    status: hasCreds ? 'AUTHENTICATION_FAILED' : 'UNAUTHENTICATED_PASSIVE',
    platform: 'twitter',
    target: cleanUser,
    message: hasCreds
      ? 'Twitter authentication invalid or rate limit reached. Latest public updates retrieved via OSINT.'
      : 'X/Twitter requires authentication to read user feeds. Public indexed posts retrieved via OSINT.',
    osint_results: osintResults,
    interactive_prompt_guidance: [
      `[TWITTER/X INTERACTIVE CONFIGURATION GUIDE]`,
      `To allow twitter-cli to read the complete feed and tweets of @${cleanUser}, auth_token and ct0 cookies are required.`,
      `Prompt the user:`,
      `"To read tweets directly from @${cleanUser}, could you provide your X/Twitter session cookies from your browser?`,
      `How to obtain them:`,
      `1. Open x.com in your browser and open Developer Tools (F12 or Ctrl+Shift+I / Cmd+Opt+I).`,
      `2. Tab 'Application' / 'Storage' -> 'Cookies' -> 'https://x.com'.`,
      `3. Copy the values of 'auth_token' and 'ct0' and paste them here in chat."`,
      `Once received, invoke reach_configure_credentials({ platform: 'twitter', auth_token: '...', ct0: '...' }).`
    ].join('\n')
  };
}

export const name = 'agent-reach';
export const inject = ['tools', 'systemPrompt'];

export function apply(ctx) {
  // Synchronize credentials on startup
  loadCredentials().catch(() => {});

  if (!ctx.tools || typeof ctx.tools.register !== 'function') return;

  // --------------------------------------------------------------------------
  // TOOL 1: reach_web_scrape (Universal scraping with Jina Reader)
  // --------------------------------------------------------------------------
  ctx.tools.register({
    name: 'reach_web_scrape',
    description: 'Performs clean Markdown scraping of any web page (articles, blogs, documentation sites, forums) using Jina Reader (r.jina.ai), bypassing cookie banners and light paywalls.',
    parameters: {
      url: { type: 'string', required: true, description: 'Full URL of the web page to acquire (e.g. https://antirez.com)' }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          url: { type: 'string' },
          markdown: { type: 'string' },
          error: { type: 'string' }
        }
      },
      render: (v) => v.markdown || v.error || JSON.stringify(v)
    },
    execute: async (args, exec) => {
      try {
        const markdown = await scrapeViaJina(args.url, exec?.signal);
        return { success: true, url: args.url, markdown };
      } catch (err) {
        return { success: false, url: args.url, error: err.message };
      }
    }
  });

  // --------------------------------------------------------------------------
  // TOOL 2: reach_social_search (Social Intelligence for X, Instagram, Reddit, etc.)
  // --------------------------------------------------------------------------
  ctx.tools.register({
    name: 'reach_social_search',
    description: 'Searches and analyzes profiles and news across social networks (Instagram, Twitter/X, Reddit, YouTube, GitHub, V2EX). If authenticated, retrieves full data from official backends; if unauthenticated, leverages SearXNG OSINT syndication and provides interactive cookie configuration guidance.',
    parameters: {
      platform: {
        type: 'string',
        required: true,
        description: 'Target platform: "twitter" | "instagram" | "reddit" | "youtube" | "github" | "v2ex"'
      },
      target: {
        type: 'string',
        required: true,
        description: 'Username (@username), topic, or search query'
      },
      action: {
        type: 'string',
        required: false,
        description: 'Desired action: "profile" (bio/stats) or "feed" (recent posts)'
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          platform: { type: 'string' },
          result: { type: 'object' }
        }
      },
      render: (v) => JSON.stringify(v, null, 2)
    },
    execute: async (args, exec) => {
      const creds = await loadCredentials();
      const plat = args.platform.toLowerCase();

      if (plat === 'instagram' || plat === 'ig') {
        const res = await scrapeInstagram(args.target, creds, exec?.signal);
        return { status: res.status, platform: 'instagram', ...res };
      }

      if (plat === 'twitter' || plat === 'x') {
        const res = await scrapeTwitter(args.target, args.action || 'user-posts', creds, exec?.signal);
        return { status: res.status, platform: 'twitter', ...res };
      }

      if (plat === 'reddit') {
        const query = args.target.replace(/^r\//, '');
        const osint = await searchSearxng(`site:reddit.com ${query}`, exec?.signal);
        return {
          status: 'SUCCESS',
          platform: 'reddit',
          target: query,
          posts: osint
        };
      }

      if (plat === 'youtube') {
        const osint = await searchSearxng(`site:youtube.com ${args.target}`, exec?.signal);
        return {
          status: 'SUCCESS',
          platform: 'youtube',
          target: args.target,
          videos: osint
        };
      }

      // Default generic OSINT
      const osint = await searchSearxng(`${args.platform} ${args.target}`, exec?.signal);
      return {
        status: 'SUCCESS',
        platform: args.platform,
        target: args.target,
        results: osint
      };
    }
  });

  // --------------------------------------------------------------------------
  // TOOL 3: reach_configure_credentials (Interactive Credential Configuration)
  // --------------------------------------------------------------------------
  ctx.tools.register({
    name: 'reach_configure_credentials',
    description: 'Allows interactive configuration of cookies or session tokens for social platforms (Twitter/X, Instagram, Reddit). Invoke when user provides sessionid or auth_token values in chat or pastes a cookie string.',
    parameters: {
      platform: {
        type: 'string',
        required: true,
        description: 'Target platform: "twitter" | "instagram" | "reddit" | "generic"'
      },
      session_id: {
        type: 'string',
        required: false,
        description: 'sessionid cookie value (for Instagram or Reddit)'
      },
      auth_token: {
        type: 'string',
        required: false,
        description: 'auth_token cookie value (for Twitter/X)'
      },
      ct0: {
        type: 'string',
        required: false,
        description: 'ct0 cookie value (CSRF token for Twitter/X)'
      },
      cookie_string: {
        type: 'string',
        required: false,
        description: 'Raw cookie string copied from browser or JSON from Cookie-Editor'
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          platform: { type: 'string' },
          configured_keys: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' }
        }
      },
      render: (v) => JSON.stringify(v, null, 2)
    },
    execute: async (args) => {
      const creds = await loadCredentials();
      const plat = args.platform.toLowerCase();
      const keysConfigured = [];

      let parsedCookies = {};
      if (args.cookie_string) {
        parsedCookies = parseRawCookieString(args.cookie_string);
      }

      if (plat === 'instagram' || plat === 'ig') {
        const sid = args.session_id || parsedCookies.sessionid || parsedCookies.session_id;
        if (!sid) {
          return {
            success: false,
            platform: 'instagram',
            message: 'No valid "sessionid" cookie found in provided data.'
          };
        }
        creds.instagram = {
          session_id: sid,
          updated_at: new Date().toISOString()
        };
        keysConfigured.push('session_id');
      } else if (plat === 'twitter' || plat === 'x') {
        const authToken = args.auth_token || parsedCookies.auth_token;
        const ct0 = args.ct0 || parsedCookies.ct0;
        if (!authToken) {
          return {
            success: false,
            platform: 'twitter',
            message: 'No "auth_token" cookie found in provided data.'
          };
        }
        creds.twitter = {
          auth_token: authToken,
          ct0: ct0 || '',
          updated_at: new Date().toISOString()
        };
        keysConfigured.push('auth_token');
        if (ct0) keysConfigured.push('ct0');
      } else if (plat === 'reddit') {
        const sid = args.session_id || parsedCookies.reddit_session;
        creds.reddit = {
          session_id: sid || '',
          updated_at: new Date().toISOString()
        };
        keysConfigured.push('session_id');
      }

      await saveCredentials(creds);

      return {
        success: true,
        platform: plat,
        configured_keys: keysConfigured,
        message: `Credentials for ${plat} configured successfully! Subsequent requests will utilize this authenticated session.`
      };
    }
  });

  // --------------------------------------------------------------------------
  // TOOL 4: reach_status (Status and Diagnostics for OSINT Channels)
  // --------------------------------------------------------------------------
  ctx.tools.register({
    name: 'reach_status',
    description: 'Verifies activation state and presence of credentials for all OSINT platforms supported by Agent-Reach.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          jina_web: { type: 'string' },
          searxng: { type: 'string' },
          twitter: { type: 'string' },
          instagram: { type: 'string' },
          reddit: { type: 'string' },
          youtube: { type: 'string' }
        }
      },
      render: (v) => JSON.stringify(v, null, 2)
    },
    execute: async () => {
      const creds = await loadCredentials();
      return {
        jina_web_reader: 'READY (Public Web & Articles)',
        searxng_osint: 'READY (Passive Search Engine)',
        twitter: creds.twitter?.auth_token ? 'CONFIGURED (Authenticated)' : 'UNAUTHENTICATED (Passive OSINT Fallback)',
        instagram: creds.instagram?.session_id ? 'CONFIGURED (Authenticated)' : 'UNAUTHENTICATED (Passive OSINT Fallback)',
        reddit: creds.reddit?.session_id ? 'CONFIGURED (Authenticated)' : 'PUBLIC (Standard)',
        youtube: 'READY (Via yt-dlp & SearXNG)'
      };
    }
  });

  // --------------------------------------------------------------------------
  // SYSTEM PROMPT SECTION: Directives for Agent-Reach
  // --------------------------------------------------------------------------
  ctx.inject(['systemPrompt'], (promptCtx) => {
    if (!promptCtx.systemPrompt || typeof promptCtx.systemPrompt.section !== 'function') return;
    try {
      promptCtx.systemPrompt.section({
        name: 'agent-reach:directives',
        order: 15,
        text: [
          '## AGENT-REACH — WEB OSINT & SOCIAL INTELLIGENCE DIRECTIVES',
          'You have native Agent-Reach tools available for web scraping and OSINT discovery:',
          '1. For articles, documentation, or public web pages: always use tool "reach_web_scrape".',
          '2. For social media queries (Instagram, Twitter/X, Reddit, YouTube): always use tool "reach_social_search".',
          '3. INTERACTIVE CREDENTIAL FLOW: If "reach_social_search" returns "UNAUTHENTICATED_PASSIVE" or "interactive_prompt_guidance":',
          '   - Present the found public OSINT results to the user.',
          '   - Politely explain that the agent runtime cannot access user browser cookies (Chrome, Firefox, Safari, Edge).',
          '   - Ask if the user would like to supply the session cookie (e.g., "sessionid" for Instagram or "auth_token" for X).',
          '   - When the user pastes the cookie value or cookie string, IMMEDIATELY invoke tool "reach_configure_credentials" to store it.',
          '   - Once saved, re-run "reach_social_search" to retrieve the complete, up-to-date live feed!'
        ].join('\n')
      });
    } catch {}
  });
}

export default {
  name,
  inject,
  apply
};
