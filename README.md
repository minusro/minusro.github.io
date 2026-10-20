# danielstanciu.com

Portfolio site. Plain HTML/CSS/JS, hosted on GitHub Pages from the `main` branch.

## Editing content

```sh
npm run edit
```

This starts a local server (no install needed, just Node 18+) and opens the editor at http://localhost:4000/editor/.

- **Projects:** title, year, categories, role, studio, platforms, tech, summary, links, a cover image and an optional hover video (MP4, WebM or an animated GIF). Images are resized to 1600px WebP on upload. **Vertical alignment** (−1 bottom, 0 centre, 1 top) picks which part of the cover and video stays in view when they're cropped to fit the card. **Hide this project** keeps a project in the editor but off the site.
- **Site & categories:** tagline, bio, email, contact links, and the category list (names, colours, order).
- Changes save automatically to `content.json` and `media/`. Tick **Preview** to see the site update next to the form.
- **Publish…** commits everything and pushes it to GitHub. On `main`, the live site updates about a minute later.

To look at the site without the editor: `npm run dev` (http://localhost:4000/). Opening `index.html` straight from Finder won't work, because the page loads `content.json`.

## Files

| Path | What it is |
|---|---|
| `index.html`, `styles.css` | Page structure and the "cyanotype" blueprint styling (light/dark follows the system setting) |
| `app.js` | Project grid: category filter, numbering, projects opening in place |
| `nav.js` | Keyboard extras: ⌘K / Ctrl+K palette, the `` ` `` console, j/k keys, year scrubber |
| `fx.js` | The interactive dot field behind the intro |
| `content.json` | All the content; the editor writes this, or edit it by hand |
| `media/` | Uploaded images and videos |
| `tools/` | Local editor and server (not published) |
| `CNAME` | Custom domain for GitHub Pages; don't delete |
