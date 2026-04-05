# diamondhacks-2026

A 
hackathon build for a senior-care robot assistant.

The setup is split into two parts:

- `frontend/` is a Svelte app powered by Vite
- `backend/` is a TypeScript API that runs with Bun

## What it does

The idea is simple: a voice-first assistant that can help with everyday tasks, speak back naturally, and give caregivers a lightweight dashboard to keep an eye on things.

## Run it locally

Do it in 3 steps:

### Bot (wake word)

**macOS** — install PortAudio first:
```bash
brew install portaudio
```


**Linux** — install PortAudio first:
```bash
sudo apt install portaudio19-dev
```


Then set up the Python environment:
```bash
cd bot
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```


### Backend

```bash
cd backend
bun install
bun run dev
```
The API health check should be available at `http://127.0.0.1:8000/health`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The app should be up at `http://localhost:5173`.

If you want to point the frontend at a specific API URL, add this in `frontend/.env.local`:

```bash
VITE_API_BASE_URL=http://127.0.0.1:8000
```

## Stack

- Svelte 5
- Vite
- TypeScript
- Bun

## Notes

- Frontend and backend are managed separately
- Bun is the expected runtime for the API
- Vite handles the local frontend dev server

## Status

Hackathon mode. Fast-moving, still being shaped, but the core structure is in place.
