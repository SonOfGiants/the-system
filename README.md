# The System

An offline fitness quest, drawn like a game system window. It is one page. Nothing is sent to a server.

Live app (after Pages is on): https://sonofgiants.github.io/the-system/

## Publishing

GitHub Pages should serve the `main` branch, folder **/** (root). On the repo: **Settings → Pages → Deploy from a branch → main → / (root) → Save.** The first build takes about a minute.

## Add it to an iPhone Home Screen

1. Open **Safari** and go to https://sonofgiants.github.io/the-system/
2. Tap **Share** (the square with the arrow).
3. Scroll the sheet and tap **Add to Home Screen**.
4. Leave the name as **The System**, then tap **Add**.

The icon opens full screen, without Safari’s address bar. After it has loaded once, it can open again with no connection.

## Your data stays on this device

Levels, quests, and logs are stored in this device’s local storage (`theSystem.fitness.v1`). They are not uploaded.

A Home Screen icon keeps its own copy of that data, separate from a normal Safari tab. Clearing website data, or deleting the icon, removes it.

Backups are on the **System** tab, under **Backup & Share**:

- **Export JSON** downloads a backup file.
- **Import JSON file** (or paste the JSON) restores a backup on this device or another one.
