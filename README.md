# PDF Unstapler

Split a PDF into one file per page, then export as a ZIP. Runs entirely in your
browser — nothing is uploaded to a server.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Build

```bash
npm run build && npm start
```

## Stack

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS
- pdf-lib (split)
- JSZip + file-saver (export)
