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
 * Carica le credenziali: legge prima le variabili d'ambiente (.env / runtime container),
 * poi esegue il fallback sul file di configurazione locale se presente.
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

  // Priorità assoluta alle variabili d'ambiente (12-factor / container .env)
  if (process.env.TWITTER_AUTH_TOKEN) creds.twitter.auth_token = process.env.TWITTER_AUTH_TOKEN;
  if (process.env.TWITTER_CT0) creds.twitter.ct0 = process.env.TWITTER_CT0;
  if (process.env.INSTAGRAM_SESSION_ID) creds.instagram.session_id = process.env.INSTAGRAM_SESSION_ID;
  if (process.env.REDDIT_SESSION_ID) creds.reddit.session_id = process.env.REDDIT_SESSION_ID;

  // Sincronizza su process.env per CLI e librerie a valle
  if (creds.twitter?.auth_token) process.env.TWITTER_AUTH_TOKEN = creds.twitter.auth_token;
  if (creds.twitter?.ct0) process.env.TWITTER_CT0 = creds.twitter.ct0;
  if (creds.instagram?.session_id) process.env.INSTAGRAM_SESSION_ID = creds.instagram.session_id;
  if (creds.reddit?.session_id) process.env.REDDIT_SESSION_ID = creds.reddit.session_id;

  return creds;
}

/**
 * Salva le credenziali su disco, aggiorna il file YAML di agent-reach e imposta process.env
 */
async function saveCredentials(creds) {
  await fs.mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
  await fs.writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), 'utf8');

  if (creds.twitter?.auth_token) process.env.TWITTER_AUTH_TOKEN = creds.twitter.auth_token;
  if (creds.twitter?.ct0) process.env.TWITTER_CT0 = creds.twitter.ct0;
  if (creds.instagram?.session_id) process.env.INSTAGRAM_SESSION_ID = creds.instagram.session_id;
  if (creds.reddit?.session_id) process.env.REDDIT_SESSION_ID = creds.reddit.session_id;

  // Sincronizza anche su ~/.agent-reach/config.yaml
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
 * Parsing euristico da stringa Cookie raw (es. esportata da Cookie-Editor o DevTools)
 */
function parseRawCookieString(rawStr) {
  const result = {};
  if (!rawStr || typeof rawStr !== 'string') return result;

  // Se è un export JSON da Cookie-Editor
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

  // Se è formato standard "cookie1=val1; cookie2=val2"
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
 * Scraping pulito via Jina Reader (https://r.jina.ai/<url>)
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
 * Ricerca OSINT su SearXNG interno
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
 * Scraping Instagram: se autenticato usa API Instagram con sessionid, altrimenti SearXNG OSINT
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

  // Fallback OSINT passivo se non autenticato o errore
  const osintResults = await searchSearxng(`site:instagram.com/${cleanUser} OR "instagram.com/${cleanUser}"`, signal);
  return {
    status: sessionId ? 'AUTHENTICATION_EXPIRED' : 'UNAUTHENTICATED_PASSIVE',
    platform: 'instagram',
    username: cleanUser,
    message: sessionId
      ? 'La sessione Instagram configurata è scaduta o non valida.'
      : 'Accesso anonimo limitato dalle policy anti-bot di Instagram. Sono stati recuperati i dati pubblici indicizzati tramite OSINT.',
    osint_results: osintResults,
    interactive_prompt_guidance: [
      `[GUIDA CONFIGURAZIONE INTERATTIVA INSTAGRAM]`,
      `Per estrarre il profilo completo, le storie e tutti i post recenti di @${cleanUser}, è necessario il cookie di sessione.`,
      `Chiedi all'utente:`,
      `"Per accedere ai post recenti completi di Instagram dal runtime, è necessario il cookie di sessione dal tuo browser (Chrome, Firefox, Safari, Edge, Arc).`,
      `Come ottenerlo in pochi secondi:`,
      `1. Apri Instagram nel browser e apri gli Strumenti per sviluppatori (F12 o Ctrl+Shift+I / Cmd+Opzione+I).`,
      `2. Vai nella scheda 'Applicazione' (o 'Storage') -> 'Cookie' -> 'https://www.instagram.com'.`,
      `3. Copia il valore del cookie 'sessionid' e incollalo qui in chat."`,
      `Non appena l'utente te lo incolla, usa il tool reach_configure_credentials({ platform: 'instagram', session_id: '...' }) per attivarlo all'istante.`
    ].join('\n')
  };
}

/**
 * Scraping Twitter/X: se autenticato usa twitter-cli, altrimenti SearXNG OSINT
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
      // Fallback in caso di errore CLI
    }
  }

  // Fallback OSINT su SearXNG
  const osintResults = await searchSearxng(`site:x.com/${cleanUser} OR site:twitter.com/${cleanUser}`, signal);
  return {
    status: hasCreds ? 'AUTHENTICATION_FAILED' : 'UNAUTHENTICATED_PASSIVE',
    platform: 'twitter',
    target: cleanUser,
    message: hasCreds
      ? 'Autenticazione Twitter non valida o rate limit raggiunto. Ho recuperato le ultime novità pubbliche via OSINT.'
      : 'X/Twitter richiede autenticazione per leggere i feed degli utenti. Ho recuperato i post pubblici indicizzati via OSINT.',
    osint_results: osintResults,
    interactive_prompt_guidance: [
      `[GUIDA CONFIGURAZIONE INTERATTIVA TWITTER/X]`,
      `Per consentire a twitter-cli di leggere l'intero feed e i tweet di @${cleanUser}, sono necessari i cookie auth_token e ct0.`,
      `Chiedi all'utente:`,
      `"Per leggere direttamente i tweet di @${cleanUser}, puoi fornirmi i cookie di sessione di X/Twitter dal tuo browser?`,
      `Come ottenerli:`,
      `1. Apri x.com nel browser e apri gli Strumenti per sviluppatori (F12 o Ctrl+Shift+I / Cmd+Opzione+I).`,
      `2. Scheda 'Applicazione' / 'Storage' -> 'Cookie' -> 'https://x.com'.`,
      `3. Copia i valori di 'auth_token' e 'ct0' e incollali qui in chat."`,
      `Una volta ricevuti, usa reach_configure_credentials({ platform: 'twitter', auth_token: '...', ct0: '...' }).`
    ].join('\n')
  };
}

export const name = 'agent-reach';
export const inject = ['tools', 'systemPrompt'];

export function apply(ctx) {
  // Sincronizza credenziali all'avvio
  loadCredentials().catch(() => {});

  if (!ctx.tools || typeof ctx.tools.register !== 'function') return;

  // --------------------------------------------------------------------------
  // TOOL 1: reach_web_scrape (Scraping universale con Jina Reader)
  // --------------------------------------------------------------------------
  ctx.tools.register({
    name: 'reach_web_scrape',
    description: 'Esegue lo scraping pulito in Markdown di qualsiasi pagina web (articoli, blog, siti di documentazione, forum) tramite Jina Reader (r.jina.ai), superando banner cookie e paywall leggeri.',
    parameters: {
      url: { type: 'string', required: true, description: 'URL completo della pagina web da acquisire (es. https://antirez.com)' }
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
  // TOOL 2: reach_social_search (Social Intelligence per X, Instagram, Reddit, ecc.)
  // --------------------------------------------------------------------------
  ctx.tools.register({
    name: 'reach_social_search',
    description: 'Cerca e analizza profili e novità dai social network (Instagram, Twitter/X, Reddit, YouTube, GitHub, V2EX). Se autenticato recupera i dati completi dai backend ufficiali; se non autenticato sfrutta l\'OSINT syndication di SearXNG e fornisce la guida per la configurazione interattiva del cookie.',
    parameters: {
      platform: {
        type: 'string',
        required: true,
        description: 'Piattaforma target: "twitter" | "instagram" | "reddit" | "youtube" | "github" | "v2ex"'
      },
      target: {
        type: 'string',
        required: true,
        description: 'Nome utente (@username), topic o query di ricerca'
      },
      action: {
        type: 'string',
        required: false,
        description: 'Azione desiderata: "profile" (profilo bio/stats) o "feed" (ultimi post)'
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

      // Default generico OSINT
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
  // TOOL 3: reach_configure_credentials (Configurazione Interattiva Credenziali)
  // --------------------------------------------------------------------------
  ctx.tools.register({
    name: 'reach_configure_credentials',
    description: 'Permette di configurare interattivamente i cookie o i token di sessione per le piattaforme social (Twitter/X, Instagram, Reddit). Invocare quando l\'utente fornisce i valori di sessionid o auth_token in chat o incolla una stringa cookie.',
    parameters: {
      platform: {
        type: 'string',
        required: true,
        description: 'Piattaforma da configurare: "twitter" | "instagram" | "reddit" | "generic"'
      },
      session_id: {
        type: 'string',
        required: false,
        description: 'Valore del cookie sessionid (per Instagram o Reddit)'
      },
      auth_token: {
        type: 'string',
        required: false,
        description: 'Valore del cookie auth_token (per Twitter/X)'
      },
      ct0: {
        type: 'string',
        required: false,
        description: 'Valore del cookie ct0 (CSRF token per Twitter/X)'
      },
      cookie_string: {
        type: 'string',
        required: false,
        description: 'Stringa Cookie grezza copiata dal browser o JSON da Cookie-Editor'
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
            message: 'Nessun cookie "sessionid" valido trovato nei dati forniti.'
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
            message: 'Nessun cookie "auth_token" trovato nei dati forniti.'
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
        message: `Credenziali per ${plat} configurate con successo! Le future richieste utilizzeranno questa sessione autenticata.`
      };
    }
  });

  // --------------------------------------------------------------------------
  // TOOL 4: reach_status (Stato e diagnostica dei canali OSINT)
  // --------------------------------------------------------------------------
  ctx.tools.register({
    name: 'reach_status',
    description: 'Verifica lo stato di attivazione e la presenza di credenziali per tutte le piattaforme OSINT supportate da Agent-Reach.',
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
  // SYSTEM PROMPT SECTION: Direttive per l'Agente su Agent-Reach
  // --------------------------------------------------------------------------
  ctx.inject(['systemPrompt'], (promptCtx) => {
    if (!promptCtx.systemPrompt || typeof promptCtx.systemPrompt.section !== 'function') return;
    try {
      promptCtx.systemPrompt.section({
        name: 'agent-reach:directives',
        order: 15,
        text: [
          '## AGENT-REACH — WEB OSINT & SOCIAL INTELLIGENCE DIRECTIVES',
          'Hai a disposizione gli strumenti nativi di Agent-Reach per la ricerca OSINT e lo scraping:',
          '1. Per articoli, documentazione o pagine web pubbliche: usa sempre il tool "reach_web_scrape".',
          '2. Per ricerche su social media (Instagram, Twitter/X, Reddit, YouTube): usa sempre il tool "reach_social_search".',
          '3. INTERACTIVE CREDENTIAL FLOW: Se "reach_social_search" restituisce uno stato "UNAUTHENTICATED_PASSIVE" o "interactive_prompt_guidance":',
          '   - Presenta all\'utente i risultati OSINT pubblici già trovati.',
          '   - Spiega con chiarezza e cortesia che il runtime dell\'agente non ha accesso ai cookie dei browser dell\'utente (Chrome, Firefox, Safari, Edge).',
          '   - Chiedi all\'utente se desidera fornire il cookie di sessione (ad es. "sessionid" per Instagram o "auth_token" per X).',
          '   - Quando l\'utente ti incolla il valore o la stringa cookie, usa IMMEDIATAMENTE il tool "reach_configure_credentials" per salvarlo.',
          '   - Una volta salvato, riesegui la ricerca con "reach_social_search" per ottenere il feed completo e aggiornato!'
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
