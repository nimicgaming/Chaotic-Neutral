# Chaotic Neutral — Deploy-Ready Bundle

This bundle reorganizes your files for hosting:
- **server.js** (your server, unchanged)
- **public/** (your `index.html`, `home.html`, CSS, and JS moved here)
- **public/js/** (`effects.js`, `geometry.js`)
- **characters.json** kept at root and also copied to `public/` (your server loads from either)

## Run locally
```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy to Render (free)
1. Create a **new GitHub repo** and push this folder.
2. In Render: **New → Web Service** → connect the repo.
3. Build command: `npm install`
4. Start command: `node server.js`
5. Instance type: **Free**.
6. Deploy → you get a public URL like `https://your-app.onrender.com`.

## Deploy to Railway (free)
1. Create a project from this GitHub repo.
2. It will auto-detect Node and `npm start`. If not, set **Start** to `node server.js`.
3. Deploy → share your Railway URL.

### Notes
- Your server imports `characters.json` from either root or `/public`, so the copy in both places ensures compatibility.
- Your client loads Socket.IO from `/socket.io/socket.io.js` served by the same server.
- If you reference `/assets/...` paths in CSS/HTML, add those files under `public/assets/...`.
