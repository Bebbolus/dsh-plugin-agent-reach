# dsh-plugin-agent-reach

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Cordis Plugin](https://img.shields.io/badge/Cordis-Plugin-blue.svg)](https://cordis.moe)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-Compatible-purple.svg)](https://github.com/deepseek-ai)

> **Autonomous Web OSINT, Multi-Platform Social Intelligence & Clean Web Scraping Plugin for DeepSeek Harness (DSH)**

`dsh-plugin-agent-reach` bridges the gap between sandboxed autonomous AI agents and the live web. Designed natively for the Cordis plugin framework within **DeepSeek Harness**, it combines **Panniantong's Agent-Reach toolsuite**, **Jina Reader markdown scraping**, and **SearXNG passive OSINT syndication** into first-class, schema-validated agent tools.

---

## 🏛️ Architectural Overview

Running agentic environments inside Docker containers or sandboxes presents a core operational challenge:
1. **Isolated Runtimes**: Sandboxed agents do not share the user's desktop browser sessions or cookies.
2. **Aggressive Anti-Bot Barriers**: Major social platforms (Twitter/X, Instagram, Reddit) enforce strict login walls, Cloudflare challenges, and IP reputation blocks (HTTP 401/403 `AbuseAlleviationError`) against headless container IPs.
3. **Hallucination Evasion**: When unauthenticated requests fail, language models risk hallucinating content or looping through broken shell commands.

`dsh-plugin-agent-reach` solves this with a **tri-layer intelligence strategy**:

```
 ┌─────────────────────────────────────────────────────────────┐
 │                      User / Agent Query                     │
 └──────────────────────────────┬──────────────────────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        ▼                                               ▼
 ┌───────────────┐                             ┌─────────────────┐
 │ Web Scraping  │                             │ Social Inquiry  │
 └──────┬────────┘                             └────────┬────────┘
        │                                               │
        ▼                                               ▼
┌────────────────┐                     ┌─────────────────────────────────┐
│  Jina Reader   │                     │ Check Env Vars / Credentials    │
│  (r.jina.ai)   │                     └────────┬────────────────┬───────┘
└────────────────┘                              │                │
                                 [Authenticated]│                │[Unauthenticated]
                                                ▼                ▼
                                  ┌──────────────────┐  ┌────────────────┐
                                  │ Direct Platform  │  │ SearXNG OSINT  │
                                  │ API / CLI Backend│  │  Syndication   │
                                  └──────────────────┘  └────────┬───────┘
                                                                 │
                                                                 ▼
                                                        ┌────────────────┐
                                                        │  Interactive   │
                                                        │ Handshake Flow │
                                                        └────────────────┘
```

1. **Clean Web Layer (Jina Reader Engine)**: Strips ads, cookie banners, tracking scripts, and navigation clutter, serving structured GitHub-Flavored Markdown directly to the model's context.
2. **Direct Authenticated Backends**: When credentials exist, requests route to official/internal endpoints (such as `twitter-cli` or Instagram private profile APIs) with authentic headers.
3. **Passive OSINT Fallback & Interactive Handshake**: When unauthenticated, the plugin queries local SearXNG search instances for indexed public snippets and instructs the model to request session cookies interactively if deep feeds are needed.

---

## 🚀 Key Features

- **Universal Web Extraction (`reach_web_scrape`)**: Converts any public URL (technical docs, blogs, GitHub issues, news) into markdown via `https://r.jina.ai/`.
- **Multi-Platform Social Intelligence (`reach_social_search`)**:
  - **Twitter / X**: Reads profiles, timelines, and threads via `twitter-cli`.
  - **Instagram**: Retrieves bio, follower metrics, and recent post metadata with rich caption and media URLs.
  - **Reddit**: Analyzes subreddits, posts, and community discussions.
  - **YouTube**: Discovers videos, metadata, and transcripts (`yt-dlp` integration).
  - **GitHub & V2EX**: Public developer feeds and repository intelligence.
- **Zero-Secret 12-Factor Architecture**:
  - Automatically prioritizes container environment variables (`TWITTER_AUTH_TOKEN`, `INSTAGRAM_SESSION_ID`, etc.).
  - No credentials are ever hardcoded or tracked in Git.
- **Cross-Browser Session Cookie Support**:
  - Compatible with cookies from any host browser: **Google Chrome, Mozilla Firefox, Apple Safari, Microsoft Edge, Brave, Arc, Opera**.
  - Supports raw string inputs, DevTools copy-paste, or JSON exports from extensions like *Cookie-Editor*.
- **Hot-Swapping & Switchboard Integration**:
  - Compatible with `dsh-plugin-cordis-switchboard` for dynamic tool pruning and real-time credential management in the web dashboard.

---

## 📦 Installation & Setup

### 1. In DeepSeek Harness (DSH) Profile

Install the plugin into your DSH web profile:

```bash
# Via pnpm in workspace
pnpm add dsh-plugin-agent-reach

# Or register in DSH profile
dsh plugin --profile web add dsh-plugin-agent-reach
```

### 2. In Docker / Containerized Setups

Ensure `dsh-plugin-agent-reach` is mounted or linked in your `entrypoint.sh`:

```bash
# Add to plugin symlinks
ln -sfn /home/node/plugins/dsh-plugin-agent-reach /workspace/node_modules/dsh-plugin-agent-reach
ln -sfn /home/node/plugins/dsh-plugin-agent-reach /home/node/.dsh/profiles/web/node_modules/dsh-plugin-agent-reach

# Register with DSH
dsh plugin --profile web add -w /home/node/plugins/dsh-plugin-agent-reach
```

---

## ⚙️ Environment Variables (Zero-Disk Secrets)

You can pass credentials securely into your container via `.env` without writing any secrets to disk:

```ini
# --- Agent-Reach OSINT & Social Credentials ---
TWITTER_AUTH_TOKEN="2b8f9e...your_auth_token_here..."
TWITTER_CT0="a1c4...your_ct0_csrf_token_here..."
INSTAGRAM_SESSION_ID="123456789%3AmzpQ...your_sessionid_here..."
REDDIT_SESSION_ID="...optional_reddit_session..."

# Network & Search endpoints
SEARXNG_URL="http://searxng:8080"
WORKSPACE_DIR="/workspace"
```

---

## 🛠️ Tools Reference

The plugin registers 4 first-class Cordis tools accessible to the agent:

### 1. `reach_web_scrape`
Fetches and converts any web page into clean, LLM-optimized Markdown.
- **Parameters**:
  - `url` (`string`, required): Full target URL (e.g. `https://antirez.com`).
- **Output**:
  ```json
  {
    "success": true,
    "url": "https://antirez.com",
    "markdown": "# Title\n\nArticle content in clean markdown..."
  }
  ```

### 2. `reach_social_search`
Performs social discovery, profile lookup, and timeline extraction.
- **Parameters**:
  - `platform` (`string`, required): `"twitter"` | `"instagram"` | `"reddit"` | `"youtube"` | `"github"` | `"v2ex"`
  - `target` (`string`, required): Handle (e.g. `@antirez`), topic, or query.
  - `action` (`string`, optional): `"profile"` | `"feed"` (default: `"feed"`).
- **Behavior**:
  - If authenticated: Returns structured profile details and recent post data.
  - If unauthenticated: Returns passive search engine results (SearXNG) and emits an `interactive_prompt_guidance` payload directing the agent to request session tokens.

### 3. `reach_configure_credentials`
Saves credentials interactively during a conversation turn.
- **Parameters**:
  - `platform` (`string`, required): `"twitter"` | `"instagram"` | `"reddit"` | `"generic"`
  - `session_id` (`string`, optional): Session cookie value (Instagram / Reddit).
  - `auth_token` (`string`, optional): Twitter `auth_token`.
  - `ct0` (`string`, optional): Twitter CSRF `ct0`.
  - `cookie_string` (`string`, optional): Raw cookie header or JSON from Cookie-Editor.
- **Output**:
  ```json
  {
    "success": true,
    "platform": "instagram",
    "configured_keys": ["session_id"],
    "message": "Credentials for instagram configured successfully!"
  }
  ```

### 4. `reach_status`
Reports live health and credential state across all supported platforms with masked tokens for safety.
- **Parameters**: None.
- **Output**:
  ```json
  {
    "jina_web_reader": "READY (Public Web & Articles)",
    "searxng_osint": "READY (Passive Search Engine)",
    "twitter": "CONFIGURED (Authenticated)",
    "instagram": "UNAUTHENTICATED (Passive OSINT Fallback)",
    "reddit": "PUBLIC (Standard)",
    "youtube": "READY (Via yt-dlp & SearXNG)"
  }
  ```

---

## 💡 How to Obtain Session Cookies (15-Second Guide)

Because the agent runs in a container, it cannot access your desktop browser. You can copy the session token from **any host browser** (Chrome, Firefox, Safari, Edge, Arc):

### Instagram
1. Open [instagram.com](https://www.instagram.com) in your browser and ensure you are logged in.
2. Press `F12` (or right-click $\rightarrow$ **Inspect** / `Cmd+Option+I` on Mac / `Ctrl+Shift+I` on Windows/Linux).
3. Open the **Application** tab (or **Storage** in Firefox) $\rightarrow$ expand **Cookies** $\rightarrow$ select `https://www.instagram.com`.
4. Locate the row named **`sessionid`**, double-click the value, and copy it.

### Twitter / X
1. Open [x.com](https://x.com) in your browser.
2. Press `F12` $\rightarrow$ **Application** / **Storage** $\rightarrow$ **Cookies** $\rightarrow$ `https://x.com`.
3. Copy the values of **`auth_token`** and **`ct0`**.

Paste them in the chat or in the **Cordis Switchboard** dashboard, and the agent activates them instantly!

---

## 🛡️ Security & Privacy Invariants

1. **Zero Secret Leakage**: Tokens are strictly used in outbound HTTP request headers to target platform APIs. They are never transmitted to LLM completion endpoints or third-party loggers.
2. **Ephemeral File Ignored**: Runtime workspace credentials (`.dsh/social_credentials.json`) are strictly git-ignored.
3. **Read-Only Invariant**: The plugin only performs passive extraction and query tasks; it never executes write actions (posting, liking, following) on behalf of user accounts.

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for more information.

---

## 👨‍💻 Author

Developed and maintained by **[Bebbolus](https://github.com/Bebbolus)** as part of the DeepSeek Harness ecosystem.
