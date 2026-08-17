# Nexus Virtual Cloud Mining Engine

A Virtual Multi-Coin Cloud Mining App & Yield Dashboard built with **Next.js-style React** (Vite), **Express.js**, and **PostgreSQL**.

## Architecture

- **Frontend:** React + Vite, Tailwind-styled dark dashboard
- **Backend:** Node.js/Express API
- **Database:** PostgreSQL relational share-ledger
- **Blockchain:** USDC deposit listener on Base mainnet
- **Protocol fee:** 5% service fee on every reward distribution

## Quick Start

1. Copy `.env.example` to `.env` and fill in real values.
2. Run `database/init.sql` against your PostgreSQL instance.
3. Install dependencies: `npm run install:all`
4. Start dev: `npm run dev`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `BASE_RPC_URL` | Base mainnet RPC endpoint |
| `PLATFORM_TREASURY_WALLET` | USDC receiving treasury wallet |
| `INTERNAL_SECRET_API_KEY` | Secret for reward webhook |
| `PORT` | Backend port (default 3000) |
| `NODE_ENV` | production / development |

## API Endpoints

- `GET /api/dashboard?wallet=0x...` — user dashboard
- `POST /api/rigs/upgrade` — upgrade rig (row-level locking)
- `POST /api/rewards/webhook` — external payout webhook

## Deployment

Built for Railway. Push to GitHub and connect the repo to Railway. Set environment variables in Railway's settings and run `database/init.sql` on the hosted database.
