# DebtWatch

<p align="center">
  <img src="frontend/src/assets/debtwatch-banner.png" alt="DebtWatch" width="720" />
</p>

**Why:** Onboarding and security review don’t scale when teams rely only on long READMEs and noisy manual triage.

**What:** DebtWatch is a GitHub-focused copilot: **scan** repos for secrets and vulnerability-shaped patterns (with an LLM second pass), and **explain** repos with AI summaries plus optional infographic visuals. Sign-in uses **Auth0**; GitHub access uses **Auth0 Token Vault** (server-side token exchange).

---

## App workflow

1. Open the app and sign in with Auth0 (Google or GitHub).
2. Enter a GitHub `owner/repo` or URL and an optional prompt.
3. **Scan:** tree walk → pattern findings → Gemini labels **REAL** vs **FALSE_POSITIVE**.
4. **Explain:** README + metadata → parallel Markdown summary and optional Gemini image stream.
5. **Analytics / history:** trends and past scans stored in the browser.

---

## Architecture

```mermaid
flowchart LR
  subgraph client [React SPA]
    A[Auth0 React SDK]
    B[Scan / Explain UI]
  end
  subgraph auth0 [Auth0]
    U[Universal Login]
    V[Token Vault exchange]
  end
  subgraph api [Node API]
    S["/api/scan"]
    TV[getGitHubTokenFromVault]
    AG[Scanner + Gemini]
  end
  subgraph external [External]
    GH[GitHub API]
    GM[Google Gemini API]
  end
  A --> U
  B -->|Bearer API JWT| S
  S --> TV
  TV --> V
  TV -->|GitHub access token| GH
  S --> AG
  AG --> GH
  AG --> GM
```

---

## Walkthrough

1. Sign in

![Sign in](frontend/src/assets/Login%20Page.png)

2. Scan a repository

![Scan](frontend/src/assets/Scan%20for%20Vulnerabilities.png)

3. Explain — summary

![Explain summary](frontend/src/assets/Repo%20Explanation%20with%20Summary.png)

4. Explain — visualization

![Explain visualization](frontend/src/assets/Repo%20Explanation%20with%20Visualization.png)

5. Analytics

![Analytics](frontend/src/assets/Analytics.png)

6. History

![History](frontend/src/assets/History%20Tab.png)

---

## Tech stack

| Layer | Stack |
|-------|--------|
| Frontend | React 19, Vite, Tailwind CSS 4, Radix Themes, Auth0 SPA SDK, Axios, react-markdown, remark-gfm, Mermaid |
| Backend | Node 20+, Express 5, TypeScript, Octokit, `@google/genai`, Auth0 JWT + Token Vault |
| Auth | Auth0 (Google + GitHub), API audience JWT |

---

## Agents and models

| Agent / stage | Role | Default model / notes |
|----------------|------|------------------------|
| Ingestion | Repo resolution, tree, blobs | `scanner.ts`, Octokit |
| Pattern hunter | Secrets + vuln-shaped regex | `scanner.ts` |
| Devil’s Advocate | REAL / FALSE_POSITIVE | `gemini-3.1-pro-preview` (`GEMINI_REASONING_MODEL`) |
| Explainer (text) | Markdown overview | same as reasoning |
| Explainer (visual) | Infographic stream | `gemini-3.1-flash-image-preview` (`GEMINI_IMAGE_MODEL`) |

Server: `GEMINI_API_KEY`, optional `GEMINI_REASONING_MODEL`, `GEMINI_IMAGE_MODEL`.

---

## Prerequisites

- Node.js **20+**
- Auth0: SPA app, API (audience), GitHub (and optional Google) connections, Token Vault for GitHub
- Google **Gemini** API key (backend)

**Backend:** `cd backend && npm install && npm run dev` — configure `.env` from `backend/.env.example`.

**Frontend:** `cd frontend && npm install && npm run dev` — configure `.env.local` from `frontend/.env.example`.

---

## Developer

**Amrutha Junnuri**  
Email: [amrutha.junnuri98@gmail.com](mailto:amrutha.junnuri98@gmail.com)

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Amrutha_Junnuri-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/amrutha-junnuri/)

---

## License

MIT License

Copyright (c) 2026 Amrutha Junnuri

