# 💾 Ownership and backups — so nobody can take it from you

The business is 4 things: **code, secrets, data, accounts.** Each with its
backup and its owner (you).

## 1) Code (git)

- Master: GitHub `bonalti1/alto-quick-comp` (branch `claude/zen-carson-snpkxa`
  for development; **Render deploys `main`** — work goes live when a PR is
  merged).
- **Local clone on YOUR computer** (do once, refresh monthly):
  ```
  git clone https://github.com/bonalti1/alto-quick-comp.git quickcomp-backup
  cd quickcomp-backup && git fetch --all
  ```
  With the local clone, the code exists even if GitHub disappears.

## 2) Secrets (.env)

- NOT in git (on purpose). They live in Render → Environment.
- Copy of every value in a password manager (1Password/Bitwarden) in a
  "Quick Comp — ENV" vault. Update the vault every time a variable is added
  or rotated. What each one is: `05-env.md`.

## 3) Data (the button)

- Clients, leads, meetings, tasks and payments live in Postgres. Code can be
  rebuilt; data can NOT.
- **Monthly, 1 click:** /admin → ⚙️ Maintenance → **⬇️ Download backup (all
  data)** → save the `quickcomp-backup-YYYY-MM-DD.json` next to the local
  clone. Includes clients (with their app data), leads, meetings, tasks and
  kv metrics; excludes session tokens and invites on purpose.
- Supabase also keeps its own automatic restorable backups, but the JSON is
  YOUR copy in YOUR hands.

## 4) Account inventory (all owned by the owner)

| Account | For what |
|---|---|
| GitHub | The code |
| Render | Hosting + env vars |
| Supabase | Database |
| Cloudflare | DNS + client custom domains |
| Stripe | Billing and Payment Links |
| GoHighLevel | Phone/SMS/WhatsApp, setters, calendar |
| Google Cloud | Maps keys |
| RentCast | Comps + property data |
| Anthropic / OpenAI | AI |
| Meta Business | Ads + pixel |

Rule: no VA owns any account; member/collaborator access with the minimum
needed.

## 5) Open security debt (until done)

- ☐ Keep `ADMIN_KEY` / `CS_KEY` / `CLOSER_KEY` unique and strong; **rotate
  any key that appears in a screenshot or a chat** (the admin key was pasted
  in a chat once — rotate it).
- ☐ `DEMO_PASS` not guessable (don't use the product name).
- After rotating: update the vault in point 2.
