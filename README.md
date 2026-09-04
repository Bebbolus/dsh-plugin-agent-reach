# dsh-plugin-agent-reach

> **Native Agent-Reach OSINT, Web Scraping and Social Media Intelligence Plugin for DeepSeek Harness (DSH)**

`dsh-plugin-agent-reach` integrates Panniantong's Agent-Reach toolchain and Jina Reader directly into the Cordis runtime of DeepSeek Harness (DSH). It equips autonomous agents with first-class tools for web extraction, social intelligence, and interactive credential management across all platforms.

---

## Features

- **Universal Clean Web Scraping (`reach_web_scrape`)**: Scrapes articles, documentation, technical blogs, and public forums into clean Markdown via Jina Reader (`https://r.jina.ai/`).
- **Social Media Intelligence (`reach_social_search`)**: Structured analysis and feed monitoring across:
  - **Twitter / X**: authenticated via `twitter-cli` or passive OSINT syndication.
  - **Instagram**: authenticated profile inspection or passive OSINT syndication.
  - **Reddit**: subreddit/user inspection and search.
  - **YouTube**: metadata and video discovery via `yt-dlp` and search engines.
  - **GitHub & V2EX**: public APIs and developer feeds.
- **Zero-Secret Architecture & 12-Factor Environment Support**:
  - Prioritizes environment variables directly (`TWITTER_AUTH_TOKEN`, `TWITTER_CT0`, `INSTAGRAM_SESSION_ID`, `REDDIT_SESSION_ID`).
  - Never stores credentials in git or unencrypted public repositories.
- **Interactive Cross-Browser Credential Configuration (`reach_configure_credentials`)**:
  - The agent or user can configure session tokens interactively.
  - Supports cookies from any browser (Chrome, Firefox, Safari, Edge, Arc, Brave) via standard DevTools or Cookie-Editor export.
- **Passive OSINT Fallback**:
  - When credentials are not configured, the plugin automatically performs passive search engine syndication via SearXNG, retrieving public post snippets and indexed summaries without failing or hallucinating.

---

## Environment Variables

You can supply credentials directly through environment variables (e.g. in your container `.env`):

| Variable | Description |
| :--- | :--- |
| `TWITTER_AUTH_TOKEN` | Twitter/X `auth_token` session cookie |
| `TWITTER_CT0` | Twitter/X `ct0` CSRF token |
| `INSTAGRAM_SESSION_ID` | Instagram `sessionid` session cookie |
| `REDDIT_SESSION_ID` | Reddit `reddit_session` cookie |
| `SEARXNG_URL` | Local SearXNG instance URL (default: `http://searxng:8080`) |
| `WORKSPACE_DIR` | Working directory path (default: `/workspace`) |

---

## Tools Reference

### 1. `reach_web_scrape`
- **Parameters**: `url` (string, required)
- **Description**: Clean Markdown extraction of any public web page or article.

### 2. `reach_social_search`
- **Parameters**:
  - `platform`: `"twitter"` \| `"instagram"` \| `"reddit"` \| `"youtube"` \| `"github"` \| `"v2ex"`
  - `target`: Username (`@username`), topic, or query.
  - `action`: `"profile"` \| `"feed"` (optional).
- **Description**: Retrieves social profile details or recent posts.

### 3. `reach_configure_credentials`
- **Parameters**: `platform`, `session_id`, `auth_token`, `ct0`, `cookie_string`.
- **Description**: Interactively stores and activates session tokens for the current workspace.

### 4. `reach_status`
- **Description**: Returns real-time health and authentication state of all OSINT channels.

---

## License

MIT
